import { describe, expect, it } from "vitest";
import { DEFAULT_EFFECTS_FILE } from "../src/config.js";
import { effectInput, effectListText, EffectsError, loadEffects, parseEffects } from "../src/core/effects.js";
import { EFFECT } from "./fakes.js";

describe("effects file", () => {
  it("ships a valid default set of image-to-video effects", () => {
    const effects = loadEffects(DEFAULT_EFFECTS_FILE);
    expect(effects.length).toBeGreaterThanOrEqual(10);
    // Discord select menus hold at most 25 options.
    expect(effects.length).toBeLessThanOrEqual(25);
    for (const effect of effects) {
      expect(effect.model).toMatch(/\/image-to-video$/);
      expect(effect.prompt.length).toBeGreaterThan(40);
    }
  });

  it("reports the effect and the field that is wrong", () => {
    expect(() => parseEffects({ effects: [{ id: "ok-one", name: "A", description: "d", model: "m", imageField: "image_url" }] }, "test.json")).toThrow(
      /test\.json: effect "ok-one" needs a "prompt"/,
    );
    expect(() => parseEffects({ effects: [{ ...EFFECT }, { ...EFFECT }] })).toThrow(/duplicate id/);
    expect(() => parseEffects({ effects: [{ ...EFFECT, id: "Bad Id" }] })).toThrow(EffectsError);
    expect(() => parseEffects({ nope: true })).toThrow(/expected/);
  });

  it("keeps the photo and prompt over preset fields", () => {
    const input = effectInput({ ...EFFECT, input: { prompt: "ignored", image_url: "ignored", resolution: "768p" } }, "popnow://f/fil_1");
    expect(input).toEqual({ prompt: EFFECT.prompt, image_url: "popnow://f/fil_1", resolution: "768p" });
  });

  it("lists effects with their ids", () => {
    expect(effectListText([EFFECT])).toContain("• Tiny Planet (tiny-planet): Your world curls into a little planet.");
    expect(effectListText([])).toMatch(/No video effects/);
  });
});
