import { APIConnectionError, APIError, WaitTimeoutError, isTerminalState, type TaskOutputAsset } from "popnow";
import type { AcceptedTask, CreateTaskPayload, PopNowApi, Quote, Task } from "./api.js";
import type { SpendLedger, SpendVerdict } from "./ledger.js";
import { creditsToUsd, firstUsd, parseUsd, usdString, type Usd } from "./money.js";

/** The slice of the PopNow API the media flow uses; tests pass a fake. */
export type MediaApi = Pick<PopNowApi, "quoteTask" | "createTask" | "waitForTask" | "getTask">;

export interface SpendPolicy {
  /** A quote whose worst case is above this (USD) is refused outright. */
  maxPerRequest: Usd;
  /** A quote whose worst case is above this (USD) needs a tap on "Confirm" first. */
  confirmAbove: Usd;
}

export type QuoteDecision =
  | { kind: "go"; worst: Usd }
  | { kind: "confirm"; worst: Usd }
  | { kind: "too_expensive"; worst: Usd; limit: Usd }
  | { kind: "over_budget"; worst: Usd; verdict: Exclude<SpendVerdict, { ok: true }> };

type QuoteAmounts = Partial<
  Pick<Quote, "maxChargeUsd" | "maxCharge" | "estimatedCost" | "expectedChargeUsd" | "expectedCharge" | "maxCredits" | "expectedCredits">
>;

/** The exact USD string the quote holds at most: `maxChargeUsd`, then its legacy aliases. */
function quoteMaxString(quote: QuoteAmounts): string | undefined {
  return [quote.maxChargeUsd, quote.maxCharge, quote.estimatedCost].find((value) => parseUsd(value) !== undefined);
}

/**
 * The most a quote can end up costing, in USD: `maxChargeUsd` (or its legacy aliases), or the
 * typical charge when there is no ceiling. Credits are read only when no USD field is there.
 */
export function worstCase(quote: QuoteAmounts): Usd {
  const max = firstUsd(quote.maxChargeUsd, quote.maxCharge, quote.estimatedCost) ?? creditsToUsd(quote.maxCredits);
  if (max !== undefined && max > 0) return max;
  const expected = firstUsd(quote.expectedChargeUsd, quote.expectedCharge) ?? creditsToUsd(quote.expectedCredits);
  if (expected !== undefined) return expected;
  // An unreadable quote must never look free.
  return Number.MAX_SAFE_INTEGER;
}

/**
 * How createTask confirms the hold: the quote's exact `maxChargeUsd` as `expectedCostUsd`. Only a
 * quote without any USD amount falls back to the deprecated `expectedCredits`; with neither, the
 * quote id alone confirms the quoted price.
 */
export function holdConfirmation(quote: QuoteAmounts): Pick<CreateTaskPayload, "expectedCostUsd" | "expectedCredits"> {
  const exact = quoteMaxString(quote);
  if (exact !== undefined) return { expectedCostUsd: exact.trim() };
  if (typeof quote.maxCredits === "number") return { expectedCredits: quote.maxCredits };
  return {};
}

/** USD held when a task was accepted. */
export function acceptedHold(accepted: Partial<Pick<AcceptedTask, "estimatedCostUsd" | "estimatedCost" | "estimatedCredits">>): Usd | undefined {
  return firstUsd(accepted.estimatedCostUsd, accepted.estimatedCost) ?? creditsToUsd(accepted.estimatedCredits);
}

/** A task's final charge once settled, otherwise its hold. */
export function taskCost(task: Partial<Pick<Task, "costUsd" | "cost" | "credits">>): Usd | undefined {
  return firstUsd(task.costUsd, task.cost) ?? creditsToUsd(task.credits);
}

/** Pure decision for one quote: refuse, ask, or go. The per-request ceiling wins over everything. */
export function decideQuote(worst: Usd, policy: SpendPolicy, budget: SpendVerdict): QuoteDecision {
  if (worst > policy.maxPerRequest) return { kind: "too_expensive", worst, limit: policy.maxPerRequest };
  if (!budget.ok) return { kind: "over_budget", worst, verdict: budget };
  if (worst > policy.confirmAbove) return { kind: "confirm", worst };
  return { kind: "go", worst };
}

export interface MediaRequest {
  /** Ledger key of the person asking, such as "tg:123". */
  user: string;
  owner: boolean;
  model: string;
  input: Record<string, unknown>;
  /** Derived from the chat event (see idempotency.ts), never random. */
  idempotencyKey: string;
}

export interface PreparedMedia {
  request: MediaRequest;
  quote: Quote;
  decision: QuoteDecision;
}

export type MediaOutcome =
  | { kind: "succeeded"; task: Task; assets: TaskOutputAsset[]; charged: Usd; final: boolean }
  | { kind: "failed"; task: Task }
  /** The local wait ran out; the task is still running and will still be billed. */
  | { kind: "still_running"; taskId: string }
  /** Nothing was submitted: the budget or the price changed since the quote. */
  | { kind: "not_submitted"; decision: QuoteDecision }
  /** The submit call failed in a way that does not say whether the task exists. Counted as spent. */
  | { kind: "unknown"; error: unknown };

export interface RunHooks {
  onAccepted?: (accepted: AcceptedTask) => void;
  onProgress?: (task: Task, elapsedMs: number) => void;
  signal?: AbortSignal;
}

export interface MediaRunnerOptions {
  retentionSeconds?: number;
  now?: () => number;
  log?: (message: string) => void;
}

const QUOTE_SAFETY_MS = 15_000;

/**
 * Quote, check, hold, submit, wait, settle. Platform code only decides how to show each step.
 */
export class MediaRunner {
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(
    private readonly api: MediaApi,
    private readonly ledger: SpendLedger,
    private readonly policy: SpendPolicy,
    private readonly options: MediaRunnerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** Free: quotes do not charge or hold anything. */
  async prepare(request: MediaRequest): Promise<PreparedMedia> {
    const quote = await this.api.quoteTask({ model: request.model, input: request.input });
    return { request, quote, decision: this.decide(request, quote) };
  }

  private decide(request: MediaRequest, quote: Quote): QuoteDecision {
    const worst = worstCase(quote);
    const budget = this.ledger.check(request.user, worst, { kind: "media", exemptFromUserCap: request.owner });
    return decideQuote(worst, this.policy, budget);
  }

  /**
   * Runs a prepared request the person has agreed to (directly, or by tapping Confirm).
   * `approvedWorst` is the amount they saw; a fresh quote above it is not submitted.
   */
  async run(prepared: PreparedMedia, hooks: RunHooks = {}): Promise<MediaOutcome> {
    const { request } = prepared;
    const approvedWorst = prepared.decision.worst;
    let quote = prepared.quote;

    if (Date.parse(quote.expiresAt) - this.now() < QUOTE_SAFETY_MS) {
      const fresh = await this.prepare(request);
      if (!this.acceptable(fresh.decision, approvedWorst)) return { kind: "not_submitted", decision: fresh.decision };
      quote = fresh.quote;
    }

    const reserved = this.ledger.reserve(request.user, worstCase(quote), {
      kind: "media",
      exemptFromUserCap: request.owner,
    });
    if (!reserved.ok) return { kind: "not_submitted", decision: { kind: "over_budget", worst: worstCase(quote), verdict: reserved } };
    let holdId = reserved.holdId;

    let accepted: AcceptedTask;
    try {
      accepted = await this.submit(request, quote);
    } catch (error) {
      if (!(error instanceof APIError && error.code === 40901)) return this.submitFailed(holdId, error);
      // The price moved between quote and submit. Quote again and resend under the same key, so a
      // task the server did accept is found again rather than created twice.
      this.ledger.release(holdId);
      const fresh = await this.prepare(request).catch(() => undefined);
      if (!fresh || !this.acceptable(fresh.decision, approvedWorst)) {
        return { kind: "not_submitted", decision: fresh?.decision ?? prepared.decision };
      }
      const again = this.ledger.reserve(request.user, worstCase(fresh.quote), {
        kind: "media",
        exemptFromUserCap: request.owner,
      });
      if (!again.ok) {
        return { kind: "not_submitted", decision: { kind: "over_budget", worst: worstCase(fresh.quote), verdict: again } };
      }
      holdId = again.holdId;
      try {
        accepted = await this.submit(request, fresh.quote);
      } catch (retryError) {
        return this.submitFailed(holdId, retryError);
      }
    }

    this.ledger.attachTask(holdId, accepted.taskId);
    const held = acceptedHold(accepted);
    if (held !== undefined) this.ledger.adjustHold(holdId, held);
    this.log(`task ${accepted.taskId} accepted, holding ${held === undefined ? "an unknown amount" : `$${usdString(held)}`}`);
    safely(() => hooks.onAccepted?.(accepted));

    const startedAt = this.now();
    let task: Task;
    try {
      task = await this.api.waitForTask(accepted.taskId, {
        timeoutMs: waitBudget(accepted.deadlineAt, this.now()),
        ...(hooks.signal ? { signal: hooks.signal } : {}),
        onUpdate: (update) => safely(() => hooks.onProgress?.(update, this.now() - startedAt)),
      });
    } catch (error) {
      if (error instanceof WaitTimeoutError || hooks.signal?.aborted) return { kind: "still_running", taskId: accepted.taskId };
      // Polling failed (network): the task is still out there; the reconciler settles it later.
      this.log(`task ${accepted.taskId}: lost track while waiting (${describe(error)})`);
      return { kind: "still_running", taskId: accepted.taskId };
    }

    const charged = this.record(holdId, task);
    if (task.state === "succeeded") {
      const assets = (task.output?.assets ?? []).filter((asset) => asset.url && !asset.unavailable && !asset.pending);
      this.log(`task ${task.taskId} succeeded, cost $${usdString(charged)}${task.settled ? "" : " (not final yet)"}`);
      return { kind: "succeeded", task, assets, charged, final: task.settled };
    }
    this.log(`task ${task.taskId} ended as ${task.state} (${task.errorCode ?? "no code"})`);
    return { kind: "failed", task };
  }

  /** Settles holds left from earlier runs or from waits that timed out. Safe to call any time. */
  async reconcile(): Promise<void> {
    for (const hold of this.ledger.pendingTasks()) {
      if (!hold.taskId || hold.kind !== "media") continue;
      try {
        const task = await this.api.getTask(hold.taskId);
        if (isTerminalState(task.state)) this.record(hold.id, task);
      } catch (error) {
        if (error instanceof APIError && error.status === 404) this.ledger.release(hold.id);
        else this.log(`reconcile ${hold.taskId}: ${describe(error)}`);
      }
    }
  }

  private acceptable(decision: QuoteDecision, approvedWorst: Usd): boolean {
    if (decision.kind === "go") return true;
    // Already confirmed: fine as long as the price did not go above what the person saw.
    return decision.kind === "confirm" && decision.worst <= approvedWorst;
  }

  private submit(request: MediaRequest, quote: Quote): Promise<AcceptedTask> {
    return this.api.createTask(
      { model: request.model, input: request.input, quoteId: quote.quoteId, ...holdConfirmation(quote) },
      {
        idempotencyKey: request.idempotencyKey,
        ...(this.options.retentionSeconds === undefined ? {} : { retentionSeconds: this.options.retentionSeconds }),
      },
    );
  }

  private submitFailed(holdId: string, error: unknown): MediaOutcome {
    if (error instanceof APIConnectionError) {
      // No usable answer even after the SDK's retries with the same idempotency key, so the task
      // may or may not exist. Count the hold as spent: the budget errs on the safe side.
      const hold = this.ledger.hold(holdId);
      this.ledger.settle(holdId, hold?.amount ?? 0);
      return { kind: "unknown", error };
    }
    this.ledger.release(holdId);
    throw error;
  }

  /** Applies a task record to its hold; returns the amount it shows. */
  private record(holdId: string, task: Task): Usd {
    const cost = taskCost(task) ?? 0;
    if (task.settled) this.ledger.settle(holdId, cost);
    else this.ledger.adjustHold(holdId, cost);
    return cost;
  }
}

/** Wait until the server's own deadline (it fails and refunds the task there), plus a margin. */
export function waitBudget(deadlineAt: string | undefined, now: number): number {
  const deadline = deadlineAt ? Date.parse(deadlineAt) : Number.NaN;
  const untilDeadline = Number.isFinite(deadline) ? deadline - now : 30 * 60_000;
  return Math.min(24 * 60 * 60_000, Math.max(60_000, untilDeadline + 2 * 60_000));
}

function safely(fn: () => unknown): void {
  try {
    const result = fn();
    if (result instanceof Promise) result.catch(() => {});
  } catch {
    // Display hooks must never break billing bookkeeping.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
