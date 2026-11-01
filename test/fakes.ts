import { vi } from "vitest";
import { loadConfig, type BotConfig } from "../src/config.js";
import type { AcceptedTask, CatalogModel, PopNowApi, Quote, Task } from "../src/core/api.js";
import type { Effect } from "../src/core/effects.js";
import { parseUsd, type Usd } from "../src/core/money.js";

export const NOW = Date.parse("2026-10-06T12:00:00Z");

/** "0.13" -> nanodollars, the unit the ledger and the spend checks use. */
export function usd(value: string): Usd {
  const parsed = parseUsd(value);
  if (parsed === undefined) throw new Error(`not a USD amount: ${value}`);
  return parsed;
}

/** The USD price fields of a quote as the API sends them, legacy aliases included. */
export function priced(max: string, expected = max): Required<Pick<Quote, "maxChargeUsd" | "expectedChargeUsd" | "maxCharge" | "estimatedCost" | "expectedCharge">> {
  return { maxChargeUsd: max, expectedChargeUsd: expected, maxCharge: max, estimatedCost: max, expectedCharge: expected };
}

/** The current quote shape: exact USD strings first, the deprecated credit projections alongside. */
export function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    quoteId: "q_1",
    model: "example/image-model/text-to-image",
    ...priced("0.001"),
    maxCredits: 1,
    expectedCredits: 1,
    currency: "USD",
    quantity: "1",
    unit: "per_image",
    expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

export function accepted(overrides: Partial<AcceptedTask> = {}): AcceptedTask {
  return {
    taskId: "job_test1",
    state: "queued",
    estimatedCostUsd: "0.001",
    estimatedCost: "0.001",
    estimatedCredits: 1,
    deadlineAt: new Date(NOW + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

export function task(overrides: Partial<Task> = {}): Task {
  return {
    taskId: "job_test1",
    model: "example/image-model/text-to-image",
    state: "succeeded",
    costUsd: "0.001",
    cost: "0.001",
    credits: 1,
    settled: true,
    createdAt: new Date(NOW).toISOString(),
    output: { assets: [{ url: "https://files.example.test/result.png", mime: "image/png", bytes: 1000 }] },
    ...overrides,
  };
}

export const IMAGE_SCHEMA = {
  type: "object",
  required: ["prompt"],
  properties: {
    prompt: { type: "string", "x-ui": { widget: "textarea", primary: true } },
    aspect_ratio: { type: "string", enum: ["1:1", "16:9", "9:16"], default: "1:1" },
    seed: { type: "integer" },
  },
};

export const I2V_SCHEMA = {
  type: "object",
  required: ["prompt", "image_url"],
  properties: {
    prompt: { type: "string", "x-ui": { widget: "textarea", primary: true } },
    image_url: { type: "string", format: "uri", "x-ui": { widget: "upload" } },
    last_image_url: { type: "string", format: "uri", "x-ui": { widget: "upload" } },
    duration_seconds: { type: "integer", default: 5, minimum: 4, maximum: 15 },
    resolution: { type: "string", enum: ["480p", "768p", "2k"], default: "768p" },
  },
};

export function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    model: "example/image-model/text-to-image",
    family: "example/image-model",
    displayName: "Example Image",
    provider: "example",
    modality: "image",
    tasks: ["text-to-image"],
    async: true,
    taskTimeoutSeconds: 600,
    enabled: true,
    available: true,
    quantityField: "",
    usd: { unit: "per_image", perUnit: "0.001", currency: "USD" },
    credits: { unit: "per_image", perUnit: 1 },
    inputSchema: IMAGE_SCHEMA,
    version: "1",
    availability: "available",
    badges: [],
    relatedModels: [],
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

export const EFFECT: Effect = {
  id: "tiny-planet",
  name: "Tiny Planet",
  description: "Your world curls into a little planet.",
  model: "example/video/image-to-video",
  imageField: "image_url",
  prompt: "The ground curls into a tiny planet.",
  input: { duration_seconds: 5, resolution: "768p" },
};

/** A PopNow stand-in: every method is a vi.fn with a sensible default. */
export function fakeApi(models: CatalogModel[] = [model()]) {
  return {
    quoteTask: vi.fn<PopNowApi["quoteTask"]>(async () => quote()),
    createTask: vi.fn<PopNowApi["createTask"]>(async () => accepted()),
    waitForTask: vi.fn<PopNowApi["waitForTask"]>(async () => task()),
    getTask: vi.fn<PopNowApi["getTask"]>(async () => task()),
    listModels: vi.fn<PopNowApi["listModels"]>(async () => ({ total: models.length, items: models })),
    getModel: vi.fn<PopNowApi["getModel"]>(async (id: string) => models.find((item) => item.model === id) ?? models[0]!),
    getBalance: vi.fn<PopNowApi["getBalance"]>(async () => ({
      availableUsd: "12.5",
      heldUsd: "0",
      totalUsd: "12.5",
      available: "12.5",
      held: "0",
      total: "12.5",
      availableCredits: 12500,
      heldCredits: 0,
      totalCredits: 12500,
    })),
    uploadBytes: vi.fn<PopNowApi["uploadBytes"]>(async () => ({
      fileId: "fil_1",
      status: "ready" as const,
      bytes: 10,
      contentType: "image/png",
      sha256: "x",
      uri: "popnow://f/fil_1",
      expiresAt: new Date(NOW + 86_400_000).toISOString(),
    })),
  } satisfies Record<keyof PopNowApi, unknown>;
}

export function testConfig(env: Record<string, string> = {}): BotConfig {
  return loadConfig({
    POPNOW_API_KEY: "sk-popnow-test",
    TELEGRAM_BOT_TOKEN: "123:abc",
    OWNER_ID: "111",
    EFFECTS_FILE: "off",
    ...env,
  }).config;
}
