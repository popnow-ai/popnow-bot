import type { TaskOutputAsset } from "popnow";
import { describe, expect, it, vi } from "vitest";
import { BotCore } from "../src/core/bot-core.js";
import { resolvePending, splitMessage, startEffect, startMedia, type Button, type MediaSurface } from "../src/core/flows.js";
import { MemoryStore } from "../src/core/store.js";
import { EFFECT, I2V_SCHEMA, fakeApi, model, NOW, quote, task, testConfig } from "./fakes.js";

const IMAGE = model();
const ANIMATE = model({
  model: "example/video-model/image-to-video",
  displayName: "Example Video",
  modality: "video",
  tasks: ["image-to-video"],
  inputSchema: I2V_SCHEMA,
  credits: { unit: "per_second", perUnit: 3 },
});

function recordingSurface() {
  const statuses: Array<{ text: string; buttons?: Button[] }> = [];
  const delivered: Array<{ asset: TaskOutputAsset; caption: string; buttons: Button[] }> = [];
  const surface: MediaSurface = {
    progressIntervalMs: 1,
    status: async (text, buttons) => void statuses.push({ text, ...(buttons ? { buttons } : {}) }),
    deliver: async (asset, caption, buttons) => void delivered.push({ asset, caption, buttons }),
    done: async () => {},
  };
  return { surface, statuses, delivered };
}

const EFFECT_ON_ANIMATE = { ...EFFECT, model: ANIMATE.model };

function makeCore(env: Record<string, string> = {}) {
  const api = fakeApi([IMAGE, ANIMATE]);
  const store = new MemoryStore();
  const core = new BotCore(
    testConfig({ DEFAULT_IMAGE_MODEL: IMAGE.model, DEFAULT_ANIMATE_MODEL: ANIMATE.model, ...env }),
    {
      api,
      store,
      effects: [EFFECT_ON_ANIMATE],
      log: () => {},
      now: () => NOW,
    },
  );
  return { core, api, store };
}

const caller = { user: "tg:111", owner: false, name: "Sam" };

describe("media flow with a fake PopNow API", () => {
  it("prices, runs and delivers a cheap image with Animate and Effects buttons", async () => {
    const { core, api } = makeCore();
    const { surface, statuses, delivered } = recordingSurface();
    await startMedia(core, caller, "image", "a lighthouse at dusk", "pnbot-k1", surface);
    expect(api.quoteTask).toHaveBeenCalledWith({ model: IMAGE.model, input: { prompt: "a lighthouse at dusk" } });
    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(statuses[0]?.text).toMatch(/Checking the price/);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.caption).toBe("Example Image · 1 credit · task job_test1");
    expect(delivered[0]?.buttons).toEqual([
      { id: "an:job_test1", label: "Animate", style: "secondary" },
      { id: "fx:job_test1", label: "Effects", style: "secondary" },
    ]);
    expect(core.ledger.snapshot("tg:111").userSettled).toBe(1);
  });

  it("asks before spending above the threshold, and only the asker can confirm", async () => {
    const { core, api } = makeCore();
    api.quoteTask.mockResolvedValue(quote({ maxCredits: 13, expectedCredits: 13 }));
    api.waitForTask.mockResolvedValue(task({ output: { assets: [{ url: "https://files.example.test/v.mp4", mime: "video/mp4" }] } }));
    const { surface, statuses, delivered } = recordingSurface();
    await startMedia(core, caller, "animate", "slow push-in", "pnbot-k2", surface, "popnow://f/fil_1");
    expect(api.createTask).not.toHaveBeenCalled();
    const ask = statuses.at(-1)!;
    expect(ask.text).toMatch(/up to 13 credits/);
    const confirm = ask.buttons!.find((button) => button.id.startsWith("ok:"))!;
    expect(confirm.label).toBe("Confirm (13 credits)");

    expect(await resolvePending(core, confirm.id, "tg:999", surface)).toMatch(/Only the person who asked/);
    expect(api.createTask).not.toHaveBeenCalled();

    expect(await resolvePending(core, confirm.id, "tg:111", surface)).toBeUndefined();
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect((api.createTask.mock.calls[0] as unknown[])[0]).toMatchObject({
      model: ANIMATE.model,
      input: { prompt: "slow push-in", image_url: "popnow://f/fil_1", duration_seconds: 5, resolution: "480p" },
    });
    expect(delivered[0]?.buttons).toEqual([]);

    // A second tap on the same button finds nothing.
    await resolvePending(core, confirm.id, "tg:111", surface);
    expect(statuses.at(-1)?.text).toMatch(/expired/);
    expect(api.createTask).toHaveBeenCalledTimes(1);
  });

  it("cancels without charging", async () => {
    const { core, api } = makeCore();
    api.quoteTask.mockResolvedValue(quote({ maxCredits: 50, expectedCredits: 50 }));
    const { surface, statuses } = recordingSurface();
    await startMedia(core, caller, "image", "x", "pnbot-k3", surface);
    const cancel = statuses.at(-1)!.buttons!.find((button) => button.id.startsWith("no:"))!;
    await resolvePending(core, cancel.id, "tg:111", surface);
    expect(statuses.at(-1)?.text).toBe("Cancelled. Nothing was charged.");
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it("refuses above the per-request limit without submitting", async () => {
    const { core, api } = makeCore({ MAX_CREDITS_PER_REQUEST: "20" });
    api.quoteTask.mockResolvedValue(quote({ maxCredits: 30, expectedCredits: 25 }));
    const { surface, statuses } = recordingSurface();
    await startMedia(core, caller, "image", "x", "pnbot-k4", surface);
    expect(statuses.at(-1)?.text).toBe("This would cost up to 30 credits, above the per-request limit of 20 credits. Nothing was charged.");
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it("refuses when today's personal limit is used up", async () => {
    const { core, api } = makeCore({ USER_DAILY_BUDGET_CREDITS: "1" });
    const { surface, statuses } = recordingSurface();
    await startMedia(core, caller, "image", "x", "pnbot-k5", surface);
    await startMedia(core, caller, "image", "y", "pnbot-k6", surface);
    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)?.text).toMatch(/daily limit of 1 credit .*Nothing was charged/);
  });

  it("explains a model rejection and keeps the money", async () => {
    const { core, api } = makeCore();
    api.waitForTask.mockResolvedValue(task({ state: "failed", cost: "0", credits: 0, settled: true, errorCode: "content_rejected", errorMessage: "Declined", output: {} }));
    const { surface, statuses, delivered } = recordingSurface();
    await startMedia(core, caller, "image", "x", "pnbot-k7", surface);
    expect(delivered).toHaveLength(0);
    expect(statuses.at(-1)?.text).toMatch(/declined this request[\s\S]*Reason: Declined/);
    expect(core.ledger.snapshot("tg:111").userSettled).toBe(0);
  });

  it("animates the bot's own image from its task with a fresh link and the original prompt", async () => {
    const { core, api } = makeCore();
    api.getTask.mockResolvedValue(task({ input: { prompt: "a lighthouse" } }));
    const source = await core.imageFromTask("job_test1");
    expect(source).toEqual({ url: "https://files.example.test/result.png", prompt: "a lighthouse" });
    expect(core.motionPrompt(undefined, source.prompt)).toBe("a lighthouse Subtle, natural motion with a slow camera push-in.");
    expect(core.motionPrompt("  the waves crash  ", source.prompt)).toBe("the waves crash");
  });
});

describe("effect flow", () => {
  it("quotes the effect preset on the photo and labels the result", async () => {
    const { core, api } = makeCore();
    api.waitForTask.mockResolvedValue(task({ output: { assets: [{ url: "https://files.example.test/fx.mp4", mime: "video/mp4" }] } }));
    const { surface, statuses, delivered } = recordingSurface();
    await startEffect(core, caller, EFFECT_ON_ANIMATE, "popnow://f/fil_9", "pnbot-fx1", surface);
    expect(statuses[0]?.text).toBe("Checking the price for the Tiny Planet effect...");
    expect(api.quoteTask).toHaveBeenCalledWith({
      model: ANIMATE.model,
      input: { duration_seconds: 5, resolution: "768p", prompt: EFFECT.prompt, image_url: "popnow://f/fil_9" },
    });
    expect(delivered[0]?.caption).toBe("Tiny Planet effect · 1 credit · task job_test1");
    expect(delivered[0]?.buttons).toEqual([]);
  });

  it("finds effects by id or name", () => {
    const { core } = makeCore();
    expect(core.findEffect("tiny-planet")?.id).toBe("tiny-planet");
    expect(core.findEffect("Tiny Planet")?.id).toBe("tiny-planet");
    expect(core.findEffect("tiny")?.id).toBe("tiny-planet");
    expect(core.findEffect("nothing like it")).toBeUndefined();
  });
});

describe("splitMessage", () => {
  it("splits long text at paragraph or line breaks", () => {
    const text = `${"a".repeat(60)}\n\n${"b".repeat(60)}`;
    expect(splitMessage(text, 100)).toEqual(["a".repeat(60), "b".repeat(60)]);
    expect(splitMessage("short", 100)).toEqual(["short"]);
    expect(splitMessage("x".repeat(250), 100).map((part) => part.length)).toEqual([100, 100, 50]);
  });
});

describe("duplicate requests", () => {
  it("runs a repeated key once while the first is still going", async () => {
    const { core, api } = makeCore();
    let finish: () => void = () => {};
    api.waitForTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(task());
        }),
    );
    const first = recordingSurface();
    const second = recordingSurface();
    const running = startMedia(core, caller, "image", "x", "pnbot-same", first.surface);
    await vi.waitFor(() => expect(api.waitForTask).toHaveBeenCalledTimes(1));
    await startMedia(core, caller, "image", "x", "pnbot-same", second.surface);
    expect(second.statuses.at(-1)?.text).toBe("Already working on this one.");
    finish();
    await running;
    expect(api.createTask).toHaveBeenCalledTimes(1);
    // Once finished, the key is free again (the server would return the same task for it).
    await startMedia(core, caller, "image", "x", "pnbot-same", second.surface);
    expect(api.quoteTask).toHaveBeenCalledTimes(2);
  });

  it("refuses a model the operator did not allow", async () => {
    const { core, api } = makeCore({ ALLOWED_MODELS: "other/*" });
    const { surface, statuses } = recordingSurface();
    await startMedia(core, caller, "image", "x", "pnbot-k9", surface);
    expect(statuses.at(-1)?.text).toMatch(/not allowed on this bot/);
    expect(api.quoteTask).not.toHaveBeenCalled();
  });
});
