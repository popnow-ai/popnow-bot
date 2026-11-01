import {
  PopNow,
  type Balance,
  type CreateTaskParams,
  type CreateTaskResponse,
  type Model,
  type ModelList,
  type ModelListParams,
  type TaskQuote,
  type TaskRecord,
  type UploadContentType,
  type UploadedFile,
} from "popnow";

export const BOT_VERSION = "0.2.0";
export const USER_AGENT = `popnow-bot/${BOT_VERSION} (+https://github.com/popnow-ai/popnow-bot)`;

/*
 * The API bills in exact USD and sends the USD fields below as decimal strings. `popnow` 0.2.0
 * declares them; they are restated here as optional so the bot keeps working against an API
 * response or a test double that only carries the legacy fields. The integer credit fields are
 * deprecated display projections (1 credit = $0.001) that the bot reads only when a USD field is missing.
 */

/** `POST /api/v1/jobs/quote`. */
export type Quote = Omit<TaskQuote, "maxCredits" | "expectedCredits" | "maxChargeUsd" | "expectedChargeUsd" | "expectedCharge"> & {
  /** Exact maximum USD held on acceptance. Sent back as `expectedCostUsd` to confirm the hold. */
  maxChargeUsd?: string;
  /** Exact typical USD charge, never above `maxChargeUsd`. Informational only. */
  expectedChargeUsd?: string;
  /** Legacy USD alias of `expectedChargeUsd`. */
  expectedCharge?: string;
  /** @deprecated Rounded credits (1 credit = $0.001). Use `maxChargeUsd`. */
  maxCredits?: number;
  /** @deprecated Rounded credits (1 credit = $0.001). Use `expectedChargeUsd`. */
  expectedCredits?: number;
};

/** `POST /api/v1/jobs/createTask` body. */
export type CreateTaskPayload = Omit<CreateTaskParams, "expectedCredits" | "expectedCost" | "expectedCostUsd"> & {
  /** Exact USD hold the caller confirmed: the quote's `maxChargeUsd`. */
  expectedCostUsd?: string;
  /** @deprecated Legacy name for `expectedCostUsd`. */
  expectedCost?: string;
  /** @deprecated Whole credits. Send `expectedCostUsd` or `quoteId` instead. */
  expectedCredits?: number;
};

/** The acceptance record of a new task. */
export type AcceptedTask = Omit<CreateTaskResponse, "estimatedCredits" | "estimatedCostUsd"> & {
  /** Exact USD held on acceptance; the most the task can cost. */
  estimatedCostUsd?: string;
  /** @deprecated Rounded credits (1 credit = $0.001). Use `estimatedCostUsd`. */
  estimatedCredits?: number;
};

/** A task record from `recordInfo` or the wait loop. */
export type Task = Omit<TaskRecord, "credits" | "exactCredits" | "costUsd"> & {
  /** Exact USD: the final charge once `settled`, otherwise the hold. */
  costUsd?: string;
  /** @deprecated Rounded credits (1 credit = $0.001). Use `costUsd`. */
  credits?: number;
  /** @deprecated Unrounded credit-scale decimal string. Use `costUsd`. */
  exactCredits?: string;
};

/** `GET /api/v1/chat/credit`: the API balance (the path name is historical). */
export type ApiBalance = Omit<Balance, "availableCredits" | "heldCredits" | "totalCredits" | "availableUsd" | "heldUsd" | "totalUsd"> & {
  /** Exact USD new tasks can use. May be negative while an approved credit line is in use. */
  availableUsd?: string;
  heldUsd?: string;
  totalUsd?: string;
  /** @deprecated Truncated credits (1 credit = $0.001). Use `availableUsd`. */
  availableCredits?: number;
  /** @deprecated Rounded credits. Use `heldUsd`. */
  heldCredits?: number;
  /** @deprecated Credits. Use `totalUsd`. */
  totalCredits?: number;
};

/** A model's USD rate snapshot; amounts are decimal strings. `jobs/quote` is the exact price. */
export interface ModelUsdRate {
  unit: string;
  currency?: "USD";
  perUnit?: string;
  rules?: Array<{ when: Record<string, unknown>; perUnit: string; unit?: string }>;
  [key: string]: unknown;
}

export type CatalogModel = Omit<Model, "credits"> & {
  usd?: ModelUsdRate;
  /** @deprecated Credit-scale rate snapshot. Use `usd`. */
  credits?: Model["credits"];
};

export type CatalogList = Omit<ModelList, "items"> & { items: CatalogModel[] };

export interface CreateOptions {
  /** Derived from the chat event (see idempotency.ts); the same key never creates a second task. */
  idempotencyKey: string;
  /** Sent as `X-PopNow-Retention`: delete outputs and prompts sooner than the account default. */
  retentionSeconds?: number;
}

export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (task: Task) => void;
}

/**
 * The PopNow calls the bot makes. `popnowApi()` maps them onto the official `popnow` SDK;
 * tests pass a fake with the same shape.
 *
 * Endpoints used: `POST /api/v1/jobs/quote`, `POST /api/v1/jobs/createTask`,
 * `GET /api/v1/jobs/recordInfo`, `GET /api/v1/models`, `GET /api/v1/models/{model}`,
 * `GET /api/v1/chat/credit` (balance), `POST /api/v1/common/upload-url` and
 * `POST /api/v1/files/{fileId}/commit`.
 */
export interface PopNowApi {
  quoteTask(payload: CreateTaskPayload): Promise<Quote>;
  createTask(payload: CreateTaskPayload, options: CreateOptions): Promise<AcceptedTask>;
  waitForTask(taskId: string, options?: WaitOptions): Promise<Task>;
  getTask(taskId: string): Promise<Task>;
  listModels(params?: ModelListParams): Promise<CatalogList>;
  getModel(model: string): Promise<CatalogModel>;
  getBalance(): Promise<ApiBalance>;
  uploadBytes(bytes: Uint8Array, options: { contentType: UploadContentType }): Promise<UploadedFile>;
}

export function createClient(apiKey: string, baseURL: string): PopNow {
  return new PopNow({
    apiKey,
    baseURL,
    maxRetries: 2,
    // The API rejects anonymous default client user agents; always say who is calling.
    defaultHeaders: { "User-Agent": USER_AGENT },
  });
}

export function popnowApi(client: PopNow): PopNowApi {
  return {
    // The SDK sends the body as given, so `expectedCostUsd` reaches the API even though popnow
    // 0.1.0 does not declare it.
    quoteTask: (payload) => client.jobs.quote(payload as CreateTaskParams),
    async createTask(payload, options) {
      // Without `wait`, createTask always answers with the short acceptance record.
      const created = await client.jobs.create(payload as CreateTaskParams, {
        idempotencyKey: options.idempotencyKey,
        ...(options.retentionSeconds === undefined ? {} : { retention: options.retentionSeconds }),
      });
      return created as AcceptedTask;
    },
    waitForTask: (taskId, options = {}) =>
      client.jobs.wait(taskId, {
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onUpdate ? { onPoll: options.onUpdate } : {}),
      }),
    getTask: (taskId) => client.jobs.get(taskId),
    listModels: (params) => client.models.list(params),
    getModel: (model) => client.models.get(model),
    getBalance: () => client.account.balance(),
    uploadBytes: (bytes, options) => client.files.upload(bytes, { contentType: options.contentType }),
  };
}
