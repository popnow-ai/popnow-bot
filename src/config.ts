import { parseIdList, type AccessPolicy } from "./core/access.js";
import { requireCredits, type Credits } from "./core/credits.js";
import type { ModelKind } from "./core/store.js";

export interface BotConfig {
  popnowApiKey: string;
  /** Root of the API without a path; the SDK adds `/api/v1/...`. */
  popnowBaseUrl: string;
  telegramToken: string | undefined;
  discordToken: string | undefined;
  /** Register Discord commands on one server only (instant) instead of globally. */
  discordGuildId: string | undefined;
  access: AccessPolicy;
  limits: { globalDaily: Credits; userDaily: Credits; maxConcurrentPerUser: number };
  spend: { maxPerRequest: Credits; confirmAbove: Credits };
  defaults: Record<ModelKind, string>;
  allowedModels: string[];
  videoSeconds: number;
  videoResolution: string | undefined;
  imageAspectRatio: string | undefined;
  /** Path of the effects file, or undefined when effects are turned off. */
  effectsFile: string | undefined;
  retentionSeconds: number | undefined;
  dataDir: string;
  allowPhotoUploads: boolean;
  progressIntervalMs: number;
  requireConsent: boolean;
}

export const DEFAULT_MODELS: Record<ModelKind, string> = {
  image: "alibaba/z-image-turbo/text-to-image",
  video: "minimax/h3/text-to-video",
  animate: "minimax/h3/image-to-video",
};

export const DEFAULT_EFFECTS_FILE = "effects/default.json";

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  override name = "ConfigError";
  constructor(readonly problems: string[]) {
    super(`Configuration problems:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
}

/**
 * Reads the configuration from environment variables. Every problem is reported at once, with
 * the variable name, so a first-time setup does not turn into a guessing game.
 */
export function loadConfig(env: Env): { config: BotConfig; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const get = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const attempt = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      problems.push((error as Error).message);
      return fallback;
    }
  };
  const credits = (name: string, fallback: string): Credits => attempt(() => requireCredits(get(name) ?? fallback, name), 0);
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number between ${min} and ${max} (got "${raw}")`);
      return fallback;
    }
    return value;
  };
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = get(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    problems.push(`${name} must be true or false (got "${raw}")`);
    return fallback;
  };

  const popnowApiKey = get("POPNOW_API_KEY") ?? "";
  if (!popnowApiKey) problems.push("POPNOW_API_KEY is required (create one at https://popnow.ai/api/console/keys)");
  else if (!popnowApiKey.startsWith("sk-popnow-")) problems.push("POPNOW_API_KEY does not look like a PopNow key (it should start with sk-popnow-)");

  const telegramToken = get("TELEGRAM_BOT_TOKEN");
  const discordToken = get("DISCORD_TOKEN");
  if (!telegramToken && !discordToken) problems.push("Set TELEGRAM_BOT_TOKEN, DISCORD_TOKEN, or both");

  const owners = attempt(() => parseIdList(get("OWNER_ID"), "OWNER_ID"), { any: false, ids: new Set<string>() });
  if (owners.any) problems.push("OWNER_ID cannot be *; list your own user ID");
  if (owners.ids.size === 0 && !owners.any) problems.push("OWNER_ID is required: your own Telegram user ID and/or Discord user ID");
  const users = attempt(() => parseIdList(get("ALLOWED_USER_IDS"), "ALLOWED_USER_IDS"), { any: false, ids: new Set<string>() });
  const chats = attempt(() => parseIdList(get("ALLOWED_CHAT_IDS"), "ALLOWED_CHAT_IDS"), { any: false, ids: new Set<string>() });
  if (users.any) warnings.push("ALLOWED_USER_IDS=* lets anyone who finds the bot spend your PopNow credits.");
  if (chats.any) warnings.push("ALLOWED_CHAT_IDS=* lets the bot answer in any group or channel it is added to.");

  const baseUrl = (get("POPNOW_BASE_URL") ?? "https://api.popnow.ai").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) problems.push("POPNOW_BASE_URL must start with https://");

  const retentionRaw = get("RETENTION_SECONDS");
  const retentionSeconds = retentionRaw === undefined ? undefined : integer("RETENTION_SECONDS", 0, 0, 14 * 86_400);

  const effectsRaw = get("EFFECTS_FILE");
  const effectsFile = effectsRaw === undefined ? DEFAULT_EFFECTS_FILE : ["off", "none", "false"].includes(effectsRaw.toLowerCase()) ? undefined : effectsRaw;

  const config: BotConfig = {
    popnowApiKey,
    popnowBaseUrl: baseUrl,
    telegramToken,
    discordToken,
    discordGuildId: get("DISCORD_GUILD_ID"),
    access: { owners, users, chats },
    limits: {
      globalDaily: credits("DAILY_BUDGET_CREDITS", "500"),
      userDaily: credits("USER_DAILY_BUDGET_CREDITS", "100"),
      maxConcurrentPerUser: integer("MAX_CONCURRENT_TASKS_PER_USER", 2, 1, 20),
    },
    spend: {
      maxPerRequest: credits("MAX_CREDITS_PER_REQUEST", "100"),
      confirmAbove: credits("CONFIRM_ABOVE_CREDITS", "10"),
    },
    defaults: {
      image: get("DEFAULT_IMAGE_MODEL") ?? DEFAULT_MODELS.image,
      video: get("DEFAULT_VIDEO_MODEL") ?? DEFAULT_MODELS.video,
      animate: get("DEFAULT_ANIMATE_MODEL") ?? DEFAULT_MODELS.animate,
    },
    allowedModels: (get("ALLOWED_MODELS") ?? "")
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
    videoSeconds: integer("VIDEO_SECONDS", 5, 1, 60),
    videoResolution: get("VIDEO_RESOLUTION") ?? "480p",
    imageAspectRatio: get("IMAGE_ASPECT_RATIO"),
    effectsFile,
    retentionSeconds,
    dataDir: get("DATA_DIR") ?? "./data",
    allowPhotoUploads: flag("ALLOW_PHOTO_UPLOADS", false),
    progressIntervalMs: integer("PROGRESS_INTERVAL_SECONDS", 6, 3, 30) * 1000,
    requireConsent: flag("REQUIRE_CONSENT", true),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return { config, warnings };
}
