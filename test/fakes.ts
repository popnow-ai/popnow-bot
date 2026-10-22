import type { CreateTaskResponse, Model, TaskQuote, TaskRecord } from "popnow";
import { vi } from "vitest";
import { loadConfig, type BotConfig } from "../src/config.js";
import type { PopNowApi } from "../src/core/api.js";
import type { Effect } from "../src/core/effects.js";

export const NOW = Date.parse("2026-10-06T12:00:00Z");

export function quote(overrides: Partial<TaskQuote> = {}): TaskQuote {
  return {
    quoteId: "q_1",
    model: "example/image-model/text-to-image",
    estimatedCost: "0.001",
    maxCharge: "0.001",
    maxCredits: 1,
    expectedCredits: 1,
    currency: "USD",
    quantity: "1",
    unit: "per_image",
    expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

export function accepted(overrides: Partial<CreateTaskResponse> = {}): CreateTaskResponse {
  return {
    taskId: "job_test1",
    state: "queued",
    estimatedCost: "0.001",
    estimatedCredits: 1,
    deadlineAt: new Date(NOW + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

export function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "job_test1",
    model: "example/image-model/text-to-image",
    state: "succeeded",
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

export function model(overrides: Partial<Model> = {}): Model {
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
export function fakeApi(models: Model[] = [model()]) {
  return {
    quoteTask: vi.fn<PopNowApi["quoteTask"]>(async () => quote()),
    createTask: vi.fn<PopNowApi["createTask"]>(async () => accepted()),
    waitForTask: vi.fn<PopNowApi["waitForTask"]>(async () => task()),
    getTask: vi.fn<PopNowApi["getTask"]>(async () => task()),
    listModels: vi.fn<PopNowApi["listModels"]>(async () => ({ total: models.length, items: models })),
    getModel: vi.fn<PopNowApi["getModel"]>(async (id: string) => models.find((item) => item.model === id) ?? models[0]!),
    getBalance: vi.fn<PopNowApi["getBalance"]>(async () => ({
      available: "12.50",
      held: "0",
      total: "12.50",
      availableCredits: 1250,
      heldCredits: 0,
      totalCredits: 1250,
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
