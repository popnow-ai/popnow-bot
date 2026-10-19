import { randomBytes } from "node:crypto";
import type { TaskRecord, UploadContentType } from "popnow";
import type { BotConfig } from "../config.js";
import { createClient, popnowApi, type PopNowApi } from "./api.js";
import { Catalog, KIND_LABEL } from "./catalog.js";
import { formatCredits, parseCredits } from "./credits.js";
import { effectInput, findEffect, loadEffects, type Effect } from "./effects.js";
import { buildMediaInput, imageField, InputError } from "./inputs.js";
import { SpendLedger } from "./ledger.js";
import { MediaRunner, type PreparedMedia } from "./media.js";
import { spendSummary } from "./messages.js";
import { JsonFileStore, type MediaKind, type ModelKind, type StateStore } from "./store.js";

export const DEFAULT_MOTION = "Subtle, natural motion with a slow camera push-in.";

export interface CoreDeps {
  api?: PopNowApi;
  store?: StateStore;
  effects?: Effect[];
  log?: (message: string) => void;
  now?: () => number;
}

export interface Caller {
  /** Ledger and preference key, such as "tg:123". */
  user: string;
  owner: boolean;
  name: string;
}

export interface PendingRequest<C> {
  id: string;
  caller: Caller;
  prepared: PreparedMedia;
  kind: MediaKind;
  modelName: string;
  context: C;
  createdAt: number;
}

/**
 * Everything both chat platforms share: settings, spend protection and PopNow calls.
 * Platform code turns chat events into calls on this class and renders what comes back.
 */
export class BotCore {
  readonly api: PopNowApi;
  readonly store: StateStore;
  readonly ledger: SpendLedger;
  readonly catalog: Catalog;
  readonly media: MediaRunner;
  readonly effects: Effect[];
  readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingRequest<unknown>>();

  constructor(
    readonly config: BotConfig,
    deps: CoreDeps = {},
  ) {
    this.log = deps.log ?? ((message) => console.log(`[popnow-bot] ${message}`));
    this.now = deps.now ?? Date.now;
    this.api = deps.api ?? popnowApi(createClient(config.popnowApiKey, config.popnowBaseUrl));
    this.store = deps.store ?? new JsonFileStore(config.dataDir, this.log);
    this.ledger = new SpendLedger(this.store.state.ledger, config.limits, () => this.store.save(), this.now);
    this.catalog = new Catalog(this.api, config.allowedModels, 10 * 60_000, this.now);
    this.media = new MediaRunner(this.api, this.ledger, config.spend, {
      ...(config.retentionSeconds === undefined ? {} : { retentionSeconds: config.retentionSeconds }),
      now: this.now,
      log: this.log,
    });
    this.effects = deps.effects ?? (config.effectsFile ? loadEffects(config.effectsFile) : []);
  }

  /** Clears leftovers from a previous run and settles tasks that finished while the bot was down. */
  async start(): Promise<void> {
    this.ledger.cleanUp();
    await this.reconcile();
  }

  async reconcile(): Promise<void> {
    await this.media.reconcile();
  }

  // ---- settings -------------------------------------------------------------------------------

  modelFor(user: string, kind: ModelKind): string {
    const chosen = this.store.state.prefs[user]?.models?.[kind];
    if (chosen && this.catalog.isAllowed(chosen)) return chosen;
    return this.config.defaults[kind];
  }

  setModel(user: string, kind: ModelKind, model: string): void {
    const prefs = (this.store.state.prefs[user] ??= {});
    (prefs.models ??= {})[kind] = model;
    this.store.save();
  }

  needsConsent(user: string): boolean {
    return this.config.requireConsent && !this.store.state.consents[user];
  }

  giveConsent(user: string): void {
    this.store.state.consents[user] = new Date(this.now()).toISOString();
    this.store.save();
  }

  findEffect(query: string): Effect | undefined {
    return findEffect(this.effects, query);
  }

  // ---- media ----------------------------------------------------------------------------------

  /** Builds the request from the model schema and quotes it. Free. */
  async prepareMedia(
    caller: Caller,
    kind: ModelKind,
    prompt: string,
    idempotencyKey: string,
    imageUrl?: string,
  ): Promise<{ prepared: PreparedMedia; modelName: string }> {
    const model = this.modelFor(caller.user, kind);
    const details = await this.callableModel(model, `Pick another ${KIND_LABEL[kind].toLowerCase()} model with /models.`);
    const input = buildMediaInput(kind, details.inputSchema, {
      prompt,
      ...(imageUrl ? { imageUrl } : {}),
      videoSeconds: this.config.videoSeconds,
      ...(this.config.videoResolution ? { videoResolution: this.config.videoResolution } : {}),
      ...(this.config.imageAspectRatio ? { aspectRatio: this.config.imageAspectRatio } : {}),
    });
    const prepared = await this.media.prepare({ user: caller.user, owner: caller.owner, model, input, idempotencyKey });
    return { prepared, modelName: details.displayName };
  }

  /** Same as prepareMedia, for a preset effect on one photo. Free. */
  async prepareEffect(caller: Caller, effect: Effect, imageUrl: string, idempotencyKey: string): Promise<{ prepared: PreparedMedia; modelName: string }> {
    const details = await this.callableModel(effect.model, "Try another effect later.");
    if (details.inputSchema && imageField(details.inputSchema) === undefined) {
      throw new InputError(`The ${effect.name} effect is set up for a model that does not take a photo. The operator needs to fix the effects file.`);
    }
    const input = effectInput(effect, imageUrl);
    const prepared = await this.media.prepare({ user: caller.user, owner: caller.owner, model: effect.model, input, idempotencyKey });
    return { prepared, modelName: `${effect.name} effect` };
  }

  private async callableModel(model: string, hint: string) {
    if (!this.catalog.isAllowed(model)) {
      throw new InputError(`${model} is not allowed on this bot (ALLOWED_MODELS). ${hint}`);
    }
    const details = await this.catalog.get(model);
    if (!details.enabled || !details.available) throw new InputError(`${details.displayName} is not available right now. ${hint}`);
    return details;
  }

  private readonly activeKeys = new Map<string, number>();

  /** Marks an idempotency key as in use; false when the same request is already running or waiting. */
  claimKey(key: string): boolean {
    const now = this.now();
    for (const [item, expiresAt] of this.activeKeys) if (expiresAt < now) this.activeKeys.delete(item);
    if (this.activeKeys.has(key)) return false;
    this.activeKeys.set(key, now + 60 * 60_000);
    return true;
  }

  releaseKey(key: string): void {
    this.activeKeys.delete(key);
  }

  /** Remembers a request that is waiting for a tap on Confirm. */
  park<C>(caller: Caller, kind: MediaKind, prepared: PreparedMedia, modelName: string, context: C): PendingRequest<C> {
    this.sweepPending();
    const item: PendingRequest<C> = {
      id: randomBytes(6).toString("base64url"),
      caller,
      prepared,
      kind,
      modelName,
      context,
      createdAt: this.now(),
    };
    this.pending.set(item.id, item);
    return item;
  }

  /**
   * Takes a parked request out for the person who asked for it; a second tap on the same button
   * finds nothing, and someone else's tap leaves it in place.
   */
  takePending<C>(id: string, user: string): PendingRequest<C> | "not_yours" | undefined {
    this.sweepPending();
    const item = this.pending.get(id) as PendingRequest<C> | undefined;
    if (!item) return undefined;
    if (item.caller.user !== user) return "not_yours";
    this.pending.delete(id);
    return item;
  }

  private sweepPending(): void {
    const cutoff = this.now() - 15 * 60_000;
    for (const [id, item] of this.pending) {
      if (item.createdAt >= cutoff) continue;
      this.pending.delete(id);
      this.releaseKey(item.prepared.request.idempotencyKey);
    }
  }

  /** The image from a task this bot created, with a fresh download link. */
  async imageFromTask(taskId: string): Promise<{ url: string; prompt: string | undefined }> {
    const task: TaskRecord = await this.api.getTask(taskId);
    const asset = task.output?.assets?.find((item) => item.url && !item.unavailable && (item.mime ?? "image/").startsWith("image/"));
    if (task.state !== "succeeded" || !asset?.url) {
      throw new InputError("That image is no longer available. Generate a new one first.");
    }
    const prompt = typeof task.input?.prompt === "string" ? task.input.prompt : undefined;
    return { url: asset.url, prompt };
  }

  /** The prompt used when someone taps Animate without describing the motion. */
  motionPrompt(motion: string | undefined, imagePrompt: string | undefined): string {
    const text = motion?.trim();
    if (text) return text;
    return imagePrompt ? `${imagePrompt.trim()} ${DEFAULT_MOTION}` : DEFAULT_MOTION;
  }

  /** Puts bytes someone sent into PopNow storage, returning a popnow://f/... address. */
  async uploadImage(bytes: Uint8Array, contentType: string): Promise<string> {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(contentType)) throw new InputError("Send the picture as a JPEG, PNG or WebP image.");
    if (bytes.byteLength > 10 * 1024 * 1024) throw new InputError("That image is larger than 10 MB. Send a smaller one.");
    const file = await this.api.uploadBytes(bytes, { contentType: contentType as UploadContentType });
    return file.uri;
  }

  // ---- spend ----------------------------------------------------------------------------------

  async spendText(caller: Caller): Promise<string> {
    let balance: string | undefined;
    if (caller.owner) {
      try {
        const result = await this.api.getBalance();
        const available = parseCredits(result.availableCredits);
        balance = available === undefined ? "unavailable right now" : formatCredits(available);
      } catch {
        balance = "unavailable right now";
      }
    }
    return spendSummary(this.ledger.snapshot(caller.user), this.config.limits, caller.owner, balance);
  }
}
