import { readFileSync } from "node:fs";

/**
 * A preset video effect: a ready-made motion prompt and locked settings for one image-to-video
 * model. Someone picks the effect and a photo; the bot fills in everything else.
 */
export interface Effect {
  /** Short id used in commands and buttons, such as "tiny-planet". */
  id: string;
  name: string;
  /** One line shown in the effect list. */
  description: string;
  /** Image-to-video model ID, such as "minimax/h3/image-to-video". */
  model: string;
  /** The model input field that takes the photo (usually "image_url"). */
  imageField: string;
  prompt: string;
  /** Fixed settings such as duration and resolution. */
  input: Record<string, unknown>;
  /** Optional link to a sample video. */
  preview?: string;
}

export class EffectsError extends Error {
  override name = "EffectsError";
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Validates the effects file. Every problem names the effect, so a typo is easy to find. */
export function parseEffects(raw: unknown, source = "effects file"): Effect[] {
  const list = Array.isArray(raw) ? raw : (raw as { effects?: unknown } | null)?.effects;
  if (!Array.isArray(list)) throw new EffectsError(`${source}: expected { "effects": [...] }`);
  const seen = new Set<string>();
  return list.map((item, index) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const label = `${source}: effect ${typeof entry.id === "string" ? `"${entry.id}"` : `#${index + 1}`}`;
    const text = (name: string): string => {
      const value = entry[name];
      if (typeof value !== "string" || !value.trim()) throw new EffectsError(`${label} needs a "${name}"`);
      return value.trim();
    };
    const id = text("id");
    if (!ID.test(id)) throw new EffectsError(`${label}: id must be lowercase letters, digits and dashes (at most 40)`);
    if (seen.has(id)) throw new EffectsError(`${label}: duplicate id`);
    seen.add(id);
    const input = entry.input ?? {};
    if (typeof input !== "object" || Array.isArray(input)) throw new EffectsError(`${label}: "input" must be an object`);
    const effect: Effect = {
      id,
      name: text("name"),
      description: text("description"),
      model: text("model"),
      imageField: text("imageField"),
      prompt: text("prompt"),
      input: input as Record<string, unknown>,
    };
    if (typeof entry.preview === "string" && entry.preview.startsWith("https://")) effect.preview = entry.preview;
    return effect;
  });
}

export function loadEffects(path: string): Effect[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new EffectsError(`Could not read the effects file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseEffects(raw, path);
}

/** Finds an effect by id or by name, ignoring case, spaces and dashes. */
export function findEffect(effects: readonly Effect[], query: string): Effect | undefined {
  const wanted = normalize(query);
  if (!wanted) return undefined;
  return effects.find((effect) => effect.id === wanted || normalize(effect.name) === wanted) ?? effects.find((effect) => effect.id.startsWith(wanted));
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The task input for one effect on one photo. The photo and prompt always win over preset fields. */
export function effectInput(effect: Effect, imageUrl: string): Record<string, unknown> {
  return { ...effect.input, prompt: effect.prompt, [effect.imageField]: imageUrl };
}

/** The effect list as plain text: one effect per line, with its id for commands. */
export function effectListText(effects: readonly Effect[]): string {
  if (effects.length === 0) return "No video effects are set up on this bot.";
  return ["Video effects (use the id or the name):", ...effects.map((effect) => `• ${effect.name} (${effect.id}): ${effect.description}`)].join("\n");
}
