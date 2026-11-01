import { randomUUID } from "node:crypto";
import { NANOS_PER_CREDIT, type Usd } from "./money.js";

export type HoldKind = "media";

/** The unit every amount in the ledger is stored in: whole nanodollars (1 USD = 1e9). */
export const LEDGER_UNIT = "usd-nanos";

/** USD set aside for a request that has not finished yet. */
export interface Hold {
  id: string;
  user: string;
  /** UTC day (YYYY-MM-DD) the money is counted against. */
  day: string;
  amount: Usd;
  kind: HoldKind;
  taskId?: string;
  createdAt: number;
}

export interface DayTotals {
  total: Usd;
  users: Record<string, Usd>;
}

export interface LedgerData {
  /** Absent in state files written by 0.1.x, whose amounts are whole credits. */
  unit?: typeof LEDGER_UNIT;
  days: Record<string, DayTotals>;
  holds: Record<string, Hold>;
}

export interface LedgerLimits {
  /** Whole-bot spend per UTC day, in USD. */
  globalDaily: Usd;
  /** Spend per person per UTC day, in USD. Owners are exempt and only bounded by globalDaily. */
  userDaily: Usd;
  /** Media tasks one person may have running at once. */
  maxConcurrentPerUser: number;
}

export interface SpendSnapshot {
  day: string;
  userSettled: Usd;
  userHeld: Usd;
  globalSettled: Usd;
  globalHeld: Usd;
  userRunning: number;
}

export type SpendVerdict =
  | { ok: true }
  | { ok: false; reason: "user_cap"; limit: Usd; remaining: Usd }
  | { ok: false; reason: "global_cap"; limit: Usd; remaining: Usd }
  | { ok: false; reason: "concurrency"; limit: number };

export interface SpendOptions {
  kind: HoldKind;
  /** Owners skip the per-person cap; the global cap still applies to them. */
  exemptFromUserCap?: boolean;
}

export function emptyLedger(): LedgerData {
  return { unit: LEDGER_UNIT, days: {}, holds: {} };
}

/**
 * Brings a stored ledger to the current unit. Files written by 0.1.x have no `unit` and count
 * whole credits; each credit is $0.001, so every amount is scaled to nanodollars exactly once.
 */
export function migrateLedger(stored: Partial<LedgerData> | undefined): LedgerData {
  const days = stored?.days ?? {};
  const holds = stored?.holds ?? {};
  if (stored?.unit === LEDGER_UNIT) return { unit: LEDGER_UNIT, days, holds };
  const scale = (amount: unknown): Usd => {
    const nanos = typeof amount === "number" && Number.isFinite(amount) ? Math.round(amount) * NANOS_PER_CREDIT : 0;
    return Number.isSafeInteger(nanos) ? Math.max(0, nanos) : Number.MAX_SAFE_INTEGER;
  };
  const migratedDays: Record<string, DayTotals> = {};
  for (const [day, totals] of Object.entries(days)) {
    migratedDays[day] = {
      total: scale(totals?.total),
      users: Object.fromEntries(Object.entries(totals?.users ?? {}).map(([user, amount]) => [user, scale(amount)])),
    };
  }
  const migratedHolds: Record<string, Hold> = {};
  for (const [id, hold] of Object.entries(holds)) migratedHolds[id] = { ...hold, amount: scale(hold.amount) };
  return { unit: LEDGER_UNIT, days: migratedDays, holds: migratedHolds };
}

export function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * The local spend ledger: what has been charged today plus what is still in flight.
 *
 * Every request is checked against "settled + held + this request" before anything is created, and
 * the check and the hold happen in one synchronous step, so two requests arriving together cannot
 * both squeeze under the same remaining budget. A hold is released (failed task) or converted into
 * the final charge (finished task) later.
 *
 * This is the friendly, early "no". The authoritative limit is the spend cap set on the API key in
 * the PopNow API console, which the server enforces no matter what happens to this file.
 */
export class SpendLedger {
  constructor(
    private readonly data: LedgerData,
    private readonly limits: LedgerLimits,
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  today(): string {
    return utcDay(this.now());
  }

  snapshot(user: string): SpendSnapshot {
    const day = this.today();
    const totals = this.data.days[day];
    let userHeld = 0;
    let globalHeld = 0;
    let userRunning = 0;
    for (const hold of Object.values(this.data.holds)) {
      if (hold.user === user && hold.kind === "media") userRunning += 1;
      if (hold.day !== day) continue;
      globalHeld += hold.amount;
      if (hold.user === user) userHeld += hold.amount;
    }
    return {
      day,
      userSettled: totals?.users[user] ?? 0,
      userHeld,
      globalSettled: totals?.total ?? 0,
      globalHeld,
      userRunning,
    };
  }

  check(user: string, amount: Usd, options: SpendOptions): SpendVerdict {
    const snap = this.snapshot(user);
    if (options.kind === "media" && snap.userRunning >= this.limits.maxConcurrentPerUser) {
      return { ok: false, reason: "concurrency", limit: this.limits.maxConcurrentPerUser };
    }
    const globalUsed = snap.globalSettled + snap.globalHeld;
    if (globalUsed + amount > this.limits.globalDaily) {
      return {
        ok: false,
        reason: "global_cap",
        limit: this.limits.globalDaily,
        remaining: Math.max(0, this.limits.globalDaily - globalUsed),
      };
    }
    if (!options.exemptFromUserCap) {
      const userUsed = snap.userSettled + snap.userHeld;
      if (userUsed + amount > this.limits.userDaily) {
        return {
          ok: false,
          reason: "user_cap",
          limit: this.limits.userDaily,
          remaining: Math.max(0, this.limits.userDaily - userUsed),
        };
      }
    }
    return { ok: true };
  }

  /** Checks and holds in one step. */
  reserve(user: string, amount: Usd, options: SpendOptions): { ok: true; holdId: string } | Exclude<SpendVerdict, { ok: true }> {
    const verdict = this.check(user, amount, options);
    if (!verdict.ok) return verdict;
    const hold: Hold = {
      id: randomUUID(),
      user,
      day: this.today(),
      amount: Math.max(0, amount),
      kind: options.kind,
      createdAt: this.now(),
    };
    this.data.holds[hold.id] = hold;
    this.onChange();
    return { ok: true, holdId: hold.id };
  }

  attachTask(holdId: string, taskId: string): void {
    const hold = this.data.holds[holdId];
    if (!hold) return;
    hold.taskId = taskId;
    this.onChange();
  }

  /** Replaces the held amount, for example with the amount the server actually held. */
  adjustHold(holdId: string, amount: Usd): void {
    const hold = this.data.holds[holdId];
    if (!hold) return;
    hold.amount = Math.max(0, amount);
    this.onChange();
  }

  /** Converts a hold into a final charge on the day it was taken. */
  settle(holdId: string, charged: Usd): void {
    const hold = this.data.holds[holdId];
    if (!hold) return;
    delete this.data.holds[holdId];
    const amount = Math.max(0, charged);
    if (amount > 0) {
      const totals = (this.data.days[hold.day] ??= { total: 0, users: {} });
      totals.total += amount;
      totals.users[hold.user] = (totals.users[hold.user] ?? 0) + amount;
    }
    this.onChange();
  }

  /** Drops a hold without charging anything (the request was never sent, or the task failed). */
  release(holdId: string): void {
    if (!this.data.holds[holdId]) return;
    delete this.data.holds[holdId];
    this.onChange();
  }

  hold(holdId: string): Hold | undefined {
    return this.data.holds[holdId];
  }

  /** Holds that point at a task whose final cost is not known yet. */
  pendingTasks(): Hold[] {
    return Object.values(this.data.holds).filter((hold) => hold.taskId !== undefined);
  }

  /**
   * Housekeeping at startup: holds without a task never reached the server (the process stopped
   * between holding and submitting), so they are released; day totals older than keepDays go.
   */
  cleanUp(keepDays = 7): void {
    let changed = false;
    for (const hold of Object.values(this.data.holds)) {
      if (hold.taskId === undefined) {
        delete this.data.holds[hold.id];
        changed = true;
      }
    }
    const cutoff = utcDay(this.now() - keepDays * 86_400_000);
    for (const day of Object.keys(this.data.days)) {
      if (day < cutoff) {
        delete this.data.days[day];
        changed = true;
      }
    }
    if (changed) this.onChange();
  }
}
