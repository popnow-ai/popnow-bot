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

export const BOT_VERSION = "0.1.0";
export const USER_AGENT = `popnow-bot/${BOT_VERSION} (+https://github.com/popnow-ai/popnow-bot)`;

export interface CreateOptions {
  /** Derived from the chat event (see idempotency.ts); the same key never creates a second task. */
  idempotencyKey: string;
  /** Sent as `X-PopNow-Retention`: delete outputs and prompts sooner than the account default. */
  retentionSeconds?: number;
}

export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (task: TaskRecord) => void;
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
  quoteTask(payload: CreateTaskParams): Promise<TaskQuote>;
  createTask(payload: CreateTaskParams, options: CreateOptions): Promise<CreateTaskResponse>;
  waitForTask(taskId: string, options?: WaitOptions): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord>;
  listModels(params?: ModelListParams): Promise<ModelList>;
  getModel(model: string): Promise<Model>;
  getBalance(): Promise<Balance>;
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
    quoteTask: (payload) => client.jobs.quote(payload),
    async createTask(payload, options) {
      // Without `wait`, createTask always answers with the short acceptance record.
      const created = await client.jobs.create(payload, {
        idempotencyKey: options.idempotencyKey,
        ...(options.retentionSeconds === undefined ? {} : { retention: options.retentionSeconds }),
      });
      return created as CreateTaskResponse;
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
