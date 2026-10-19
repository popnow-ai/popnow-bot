import { APIConnectionError, APIError, WaitTimeoutError } from "popnow";
import { describe, expect, it } from "vitest";
import { emptyLedger, SpendLedger } from "../src/core/ledger.js";
import { decideQuote, MediaRunner, waitBudget, worstCase, type MediaRequest } from "../src/core/media.js";
import { accepted, fakeApi, NOW, quote, task } from "./fakes.js";

const policy = { maxPerRequest: 100, confirmAbove: 10 };
const limits = { globalDaily: 500, userDaily: 100, maxConcurrentPerUser: 2 };
const priceChanged = () => new APIError({ status: 409, code: 40901, message: "price changed" });

function setup(api = fakeApi()) {
  const data = emptyLedger();
  const ledger = new SpendLedger(data, limits, () => {}, () => NOW);
  const runner = new MediaRunner(api, ledger, policy, { now: () => NOW });
  const request: MediaRequest = { user: "tg:1", owner: false, model: "example/image-model/text-to-image", input: { prompt: "a lighthouse" }, idempotencyKey: "pnbot-key-1" };
  return { api, ledger, runner, request, data };
}

describe("worstCase", () => {
  it("prefers maxCredits and falls back to expectedCredits", () => {
    expect(worstCase({ maxCredits: 30, expectedCredits: 12 })).toBe(30);
    expect(worstCase({ maxCredits: 0, expectedCredits: 12 })).toBe(12);
  });

  it("never treats an unreadable quote as free", () => {
    expect(worstCase({ maxCredits: Number.NaN, expectedCredits: -1 })).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("decideQuote", () => {
  it("goes at or below the confirmation threshold", () => {
    expect(decideQuote(10, policy, { ok: true })).toEqual({ kind: "go", worst: 10 });
  });

  it("asks for confirmation above the threshold", () => {
    expect(decideQuote(11, policy, { ok: true })).toEqual({ kind: "confirm", worst: 11 });
  });

  it("refuses above the per-request ceiling, even with budget left", () => {
    expect(decideQuote(101, policy, { ok: true })).toEqual({ kind: "too_expensive", worst: 101, limit: 100 });
  });

  it("refuses when the daily budget would be exceeded", () => {
    const verdict = { ok: false as const, reason: "user_cap" as const, limit: 100, remaining: 5 };
    expect(decideQuote(8, policy, verdict)).toEqual({ kind: "over_budget", worst: 8, verdict });
  });
});

describe("MediaRunner", () => {
  it("prepares without holding anything", async () => {
    const { runner, request, ledger } = setup();
    const prepared = await runner.prepare(request);
    expect(prepared.decision.kind).toBe("go");
    expect(ledger.snapshot("tg:1").userHeld).toBe(0);
  });

  it("asks for confirmation for expensive requests", async () => {
    const api = fakeApi();
    api.quoteTask.mockResolvedValue(quote({ maxCredits: 13, expectedCredits: 13 }));
    const { runner, request } = setup(api);
    expect((await runner.prepare(request)).decision).toEqual({ kind: "confirm", worst: 13 });
  });

  it("submits with the quote, the derived idempotency key, then settles the final cost", async () => {
    const api = fakeApi();
    api.waitForTask.mockResolvedValue(task({ credits: 1, settled: true }));
    const { runner, request, ledger } = setup(api);
    const outcome = await runner.run(await runner.prepare(request));
    expect(api.createTask).toHaveBeenCalledWith(
      { model: request.model, input: request.input, quoteId: "q_1", expectedCredits: 1 },
      { idempotencyKey: "pnbot-key-1" },
    );
    expect(outcome).toMatchObject({ kind: "succeeded", charged: 1, final: true });
    expect(ledger.snapshot("tg:1")).toMatchObject({ userSettled: 1, userHeld: 0, userRunning: 0 });
  });

  it("keeps an unsettled cost as a hold for the reconciler", async () => {
    const api = fakeApi();
    api.waitForTask.mockResolvedValue(task({ credits: 2, settled: false }));
    const { runner, request, ledger } = setup(api);
    await runner.run(await runner.prepare(request));
    expect(ledger.pendingTasks()).toHaveLength(1);
    api.getTask.mockResolvedValue(task({ credits: 1, settled: true }));
    await runner.reconcile();
    expect(ledger.pendingTasks()).toHaveLength(0);
    expect(ledger.snapshot("tg:1").userSettled).toBe(1);
  });

  it("charges nothing for a failed task", async () => {
    const api = fakeApi();
    api.waitForTask.mockResolvedValue(task({ state: "failed", cost: "0", credits: 0, settled: true, errorCode: "content_rejected", output: {} }));
    const { runner, request, ledger } = setup(api);
    const outcome = await runner.run(await runner.prepare(request));
    expect(outcome.kind).toBe("failed");
    expect(ledger.snapshot("tg:1")).toMatchObject({ userSettled: 0, userHeld: 0 });
  });

  it("re-quotes and resends under the same key when the price moved (40901)", async () => {
    const api = fakeApi();
    api.createTask
      .mockRejectedValueOnce(priceChanged())
      .mockResolvedValueOnce(accepted());
    api.quoteTask.mockResolvedValueOnce(quote()).mockResolvedValueOnce(quote({ quoteId: "q_2", maxCredits: 2, expectedCredits: 2 }));
    const { runner, request } = setup(api);
    const outcome = await runner.run(await runner.prepare(request));
    expect(outcome.kind).toBe("succeeded");
    expect(api.createTask).toHaveBeenCalledTimes(2);
    const keys = api.createTask.mock.calls.map((call) => (call as unknown[])[1]);
    expect(keys).toEqual([{ idempotencyKey: "pnbot-key-1" }, { idempotencyKey: "pnbot-key-1" }]);
    expect((api.createTask.mock.calls[1] as unknown[])[0]).toMatchObject({ quoteId: "q_2", expectedCredits: 2 });
  });

  it("does not resend when the new price is above what was confirmed", async () => {
    const api = fakeApi();
    api.quoteTask.mockResolvedValueOnce(quote({ maxCredits: 20, expectedCredits: 20 })).mockResolvedValueOnce(quote({ maxCredits: 30, expectedCredits: 30 }));
    api.createTask.mockRejectedValueOnce(priceChanged());
    const { runner, request, ledger } = setup(api);
    const prepared = await runner.prepare(request);
    expect(prepared.decision.kind).toBe("confirm");
    const outcome = await runner.run(prepared);
    expect(outcome).toMatchObject({ kind: "not_submitted", decision: { kind: "confirm", worst: 30 } });
    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot("tg:1").userHeld).toBe(0);
  });

  it("re-quotes an expired quote before submitting", async () => {
    const api = fakeApi();
    api.quoteTask.mockResolvedValueOnce(quote({ expiresAt: new Date(NOW - 1000).toISOString() })).mockResolvedValueOnce(quote({ quoteId: "q_fresh" }));
    const { runner, request } = setup(api);
    await runner.run(await runner.prepare(request));
    expect((api.createTask.mock.calls[0] as unknown[])[0]).toMatchObject({ quoteId: "q_fresh" });
  });

  it("refuses at submit time when the budget filled up meanwhile", async () => {
    const { runner, request, ledger } = setup();
    const prepared = await runner.prepare(request);
    ledger.reserve("tg:1", 100, { kind: "media" });
    const outcome = await runner.run(prepared);
    expect(outcome).toMatchObject({ kind: "not_submitted", decision: { kind: "over_budget" } });
  });

  it("counts the hold as spent when the submit result is unknown", async () => {
    const api = fakeApi();
    api.createTask.mockRejectedValue(new APIConnectionError("network down"));
    const { runner, request, ledger } = setup(api);
    const outcome = await runner.run(await runner.prepare(request));
    expect(outcome.kind).toBe("unknown");
    expect(ledger.snapshot("tg:1")).toMatchObject({ userSettled: 1, userHeld: 0 });
  });

  it("releases the hold and rethrows on a definite rejection", async () => {
    const api = fakeApi();
    api.createTask.mockRejectedValue(new APIError({ status: 402, code: 40201, message: "balance" }));
    const { runner, request, ledger } = setup(api);
    await expect(runner.run(await runner.prepare(request))).rejects.toBeInstanceOf(APIError);
    expect(ledger.snapshot("tg:1").userHeld).toBe(0);
  });

  it("reports a still-running task after the wait budget and keeps its hold", async () => {
    const api = fakeApi();
    api.waitForTask.mockRejectedValue(new WaitTimeoutError("still running"));
    const { runner, request, ledger } = setup(api);
    const outcome = await runner.run(await runner.prepare(request));
    expect(outcome).toEqual({ kind: "still_running", taskId: "job_test1" });
    expect(ledger.pendingTasks()[0]?.taskId).toBe("job_test1");
  });

  it("passes progress to the display hook without letting it break billing", async () => {
    const api = fakeApi();
    api.waitForTask.mockImplementation(async (_id, options) => {
      await options?.onUpdate?.(task({ state: "running" }));
      return task();
    });
    const { runner, request } = setup(api);
    const states: string[] = [];
    const outcome = await runner.run(await runner.prepare(request), {
      onProgress: (update) => {
        states.push(update.state);
        throw new Error("display failed");
      },
    });
    expect(states).toEqual(["running"]);
    expect(outcome.kind).toBe("succeeded");
  });
});

describe("waitBudget", () => {
  it("waits until the server deadline plus a margin", () => {
    expect(waitBudget(new Date(NOW + 10 * 60_000).toISOString(), NOW)).toBe(12 * 60_000);
    expect(waitBudget(undefined, NOW)).toBe(32 * 60_000);
    expect(waitBudget(new Date(NOW - 60 * 60_000).toISOString(), NOW)).toBe(60_000);
  });
});
