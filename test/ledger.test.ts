import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyLedger, LEDGER_UNIT, migrateLedger, SpendLedger, type LedgerData } from "../src/core/ledger.js";
import { parseCredits, requireCredits } from "../src/core/credits.js";
import { creditsToUsd, formatUsd, parseSignedUsd, parseUsd, requireUsd, usdString } from "../src/core/money.js";
import { JsonFileStore } from "../src/core/store.js";

/** Dollar amounts written the way people think about them, as exact nanodollars. */
const usd = (value: string) => parseUsd(value)!;
const limits = { globalDaily: usd("5"), userDaily: usd("1"), maxConcurrentPerUser: 2 };

function ledger(now = { t: Date.parse("2026-10-06T10:00:00Z") }, data: LedgerData = emptyLedger()) {
  let saves = 0;
  const instance = new SpendLedger(data, limits, () => saves++, () => now.t);
  return { instance, now, data, saves: () => saves };
}

describe("USD amounts", () => {
  it("reads exact decimal strings of up to nine places into whole nanodollars", () => {
    expect(parseUsd("0.0405")).toBe(40_500_000);
    expect(parseUsd("12.345678901")).toBe(12_345_678_901);
    expect(parseUsd(" 5 ")).toBe(5_000_000_000);
    expect(parseUsd("0.000000001")).toBe(1);
    // 0.1 + 0.2 is exact here, unlike with floats.
    expect(parseUsd("0.1")! + parseUsd("0.2")!).toBe(parseUsd("0.3"));
  });

  it("refuses anything that is not a plain non-negative decimal", () => {
    for (const bad of ["", "abc", "1e-3", "0.0000000001", "-1", "1,000", ".5", "5.", undefined, 0.5]) {
      expect(parseUsd(bad), String(bad)).toBeUndefined();
    }
    expect(parseSignedUsd("-1.5")).toBe(-1_500_000_000);
    expect(parseSignedUsd("-0")).toBe(0);
  });

  it("formats with at least two decimals and every significant digit", () => {
    expect(formatUsd(usd("5"))).toBe("$5.00");
    expect(formatUsd(usd("0.1"))).toBe("$0.10");
    expect(formatUsd(usd("0.0405"))).toBe("$0.0405");
    expect(formatUsd(usd("1250.5"))).toBe("$1,250.50");
    expect(formatUsd(usd("0.000000001"))).toBe("$0.000000001");
    expect(formatUsd(-usd("1.5"))).toBe("-$1.50");
    expect(formatUsd(Number.MAX_SAFE_INTEGER)).toBe("an unknown amount");
    expect(usdString(usd("0.0405"))).toBe("0.0405");
    expect(usdString(usd("5"))).toBe("5");
  });

  it("converts deprecated whole credits at $0.001 each", () => {
    expect(creditsToUsd(34)).toBe(usd("0.034"));
    expect(creditsToUsd("1000")).toBe(usd("1"));
    expect(creditsToUsd(1.5)).toBeUndefined();
    expect(creditsToUsd(-1)).toBeUndefined();
  });

  it("explains a bad configuration value", () => {
    expect(requireUsd("$2.50", "DAILY_BUDGET_USD")).toBe(usd("2.5"));
    expect(() => requireUsd("five", "DAILY_BUDGET_USD")).toThrow(/DAILY_BUDGET_USD must be a US dollar amount/);
  });
});

describe("legacy credits", () => {
  it("reads whole, non-negative credit amounts only", () => {
    expect(parseCredits(12)).toBe(12);
    expect(parseCredits("40")).toBe(40);
    expect(parseCredits(" 7 ")).toBe(7);
    expect(parseCredits("0.5")).toBeUndefined();
    expect(parseCredits(-1)).toBeUndefined();
    expect(parseCredits(1.5)).toBeUndefined();
    expect(parseCredits("abc")).toBeUndefined();
    expect(parseCredits(undefined)).toBeUndefined();
  });

  it("explains a bad legacy configuration value", () => {
    expect(() => requireCredits("5.50", "DAILY_BUDGET_CREDITS")).toThrow(/DAILY_BUDGET_CREDITS must be a whole number/);
  });
});

describe("ledger migration", () => {
  const legacy = {
    days: { "2026-10-06": { total: 340, users: { "tg:1": 300, "tg:2": 40 } } },
    holds: { h: { id: "h", user: "tg:1", day: "2026-10-06", amount: 41, kind: "media" as const, createdAt: 0, taskId: "job_1" } },
  };

  it("converts a 0.1.x ledger in credits to USD exactly once", () => {
    const migrated = migrateLedger(legacy);
    expect(migrated.unit).toBe(LEDGER_UNIT);
    expect(migrated.days["2026-10-06"]).toEqual({ total: usd("0.34"), users: { "tg:1": usd("0.3"), "tg:2": usd("0.04") } });
    expect(migrated.holds.h?.amount).toBe(usd("0.041"));
    expect(migrateLedger(migrated)).toEqual(migrated);
  });

  it("migrates the state file written by 0.1.x when the bot starts", () => {
    const dir = mkdtempSync(join(tmpdir(), "popnow-bot-state-"));
    try {
      writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, ledger: legacy, prefs: {}, consents: {} }));
      const store = new JsonFileStore(dir, () => {});
      expect(store.state.ledger.unit).toBe(LEDGER_UNIT);
      expect(store.state.ledger.days["2026-10-06"]?.total).toBe(usd("0.34"));
      store.save();
      expect(new JsonFileStore(dir, () => {}).state.ledger.days["2026-10-06"]?.total).toBe(usd("0.34"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SpendLedger", () => {
  it("counts settled spend and holds in flight against the daily caps", () => {
    const { instance } = ledger();
    const first = instance.reserve("tg:1", usd("0.6"), { kind: "media" });
    expect(first.ok).toBe(true);
    // 0.6 held + 0.5 asked > 1.00 per person
    const second = instance.check("tg:1", usd("0.5"), { kind: "media" });
    expect(second).toMatchObject({ ok: false, reason: "user_cap", remaining: usd("0.4") });
    if (first.ok) instance.settle(first.holdId, usd("0.3"));
    expect(instance.check("tg:1", usd("0.5"), { kind: "media" })).toEqual({ ok: true });
    const snap = instance.snapshot("tg:1");
    expect(snap.userSettled).toBe(usd("0.3"));
    expect(snap.userHeld).toBe(0);
    expect(snap.globalSettled).toBe(usd("0.3"));
  });

  it("releases a hold without charging it", () => {
    const { instance } = ledger();
    const hold = instance.reserve("tg:1", usd("0.9"), { kind: "media" });
    if (!hold.ok) throw new Error("expected a hold");
    instance.release(hold.holdId);
    expect(instance.snapshot("tg:1")).toMatchObject({ userSettled: 0, userHeld: 0, userRunning: 0 });
  });

  it("lets owners past the per-person cap but never past the global cap", () => {
    const { instance } = ledger();
    expect(instance.reserve("tg:owner", usd("3"), { kind: "media", exemptFromUserCap: true }).ok).toBe(true);
    expect(instance.check("tg:owner", usd("1.5"), { kind: "media", exemptFromUserCap: true }).ok).toBe(true);
    expect(instance.check("tg:owner", usd("2.5"), { kind: "media", exemptFromUserCap: true })).toMatchObject({
      ok: false,
      reason: "global_cap",
      remaining: usd("2"),
    });
  });

  it("applies the global cap across people", () => {
    const { instance } = ledger();
    for (let i = 0; i < 5; i++) {
      const hold = instance.reserve(`tg:${i}`, usd("0.9"), { kind: "media" });
      if (hold.ok) instance.settle(hold.holdId, usd("0.9"));
    }
    expect(instance.check("tg:99", usd("0.6"), { kind: "media" })).toMatchObject({ ok: false, reason: "global_cap" });
  });

  it("limits media tasks running at once per person", () => {
    const { instance } = ledger();
    expect(instance.reserve("tg:1", usd("0.01"), { kind: "media" }).ok).toBe(true);
    expect(instance.reserve("tg:1", usd("0.01"), { kind: "media" }).ok).toBe(true);
    expect(instance.reserve("tg:1", usd("0.01"), { kind: "media" })).toMatchObject({ ok: false, reason: "concurrency", limit: 2 });
    expect(instance.reserve("tg:2", usd("0.01"), { kind: "media" }).ok).toBe(true);
  });

  it("starts a fresh day at 00:00 UTC and books settlements on the day of the hold", () => {
    const { instance, now } = ledger();
    const hold = instance.reserve("tg:1", usd("0.8"), { kind: "media" });
    if (!hold.ok) throw new Error("expected a hold");
    now.t = Date.parse("2026-10-07T00:00:01Z");
    // Yesterday's hold no longer counts against today's budget.
    expect(instance.check("tg:1", usd("0.9"), { kind: "media" }).ok).toBe(true);
    instance.settle(hold.holdId, usd("0.8"));
    expect(instance.snapshot("tg:1").userSettled).toBe(0);
  });

  it("persists every change", () => {
    const { instance, saves } = ledger();
    const hold = instance.reserve("tg:1", usd("0.1"), { kind: "media" });
    if (!hold.ok) throw new Error("expected a hold");
    instance.attachTask(hold.holdId, "job_1");
    instance.settle(hold.holdId, usd("0.1"));
    expect(saves()).toBe(3);
  });

  it("cleans up holds that never reached the server, and old days", () => {
    const data: LedgerData = {
      days: { "2026-09-01": { total: 5, users: {} }, "2026-10-06": { total: 1, users: {} } },
      holds: {
        a: { id: "a", user: "tg:1", day: "2026-10-06", amount: 10, kind: "media", createdAt: 0 },
        b: { id: "b", user: "tg:1", day: "2026-10-06", amount: 10, kind: "media", createdAt: 0, taskId: "job_b" },
      },
    };
    const { instance } = ledger(undefined, data);
    instance.cleanUp();
    expect(Object.keys(data.holds)).toEqual(["b"]);
    expect(Object.keys(data.days)).toEqual(["2026-10-06"]);
    expect(instance.pendingTasks().map((hold) => hold.taskId)).toEqual(["job_b"]);
  });
});
