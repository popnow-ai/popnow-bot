import type { TaskOutputAsset } from "popnow";
import type { BotCore, Caller } from "./bot-core.js";
import { formatCredits } from "./credits.js";
import type { Effect } from "./effects.js";
import type { PreparedMedia } from "./media.js";
import {
  STILL_RUNNING,
  confirmText,
  describeError,
  describeFailedTask,
  describeRefusal,
  progressText,
  resultCaption,
} from "./messages.js";
import type { MediaKind, ModelKind } from "./store.js";
import { ThrottledEditor } from "./throttle.js";

export interface Button {
  /** Callback data / custom ID; at most 64 bytes for Telegram. */
  id: string;
  label: string;
  style?: "primary" | "secondary" | "danger";
}

/** How a chat platform shows one media request: a status message that is edited, then the result. */
export interface MediaSurface {
  status(text: string, buttons?: Button[]): Promise<void>;
  deliver(asset: TaskOutputAsset, caption: string, buttons: Button[]): Promise<void>;
  /** The status message is no longer needed (the result was delivered). */
  done(): Promise<void>;
  /** Optional "uploading video..." style indicator, called on every progress tick. */
  activity?(kind: MediaKind): void;
  progressIntervalMs: number;
}

export const CALLBACK = {
  confirm: "ok:",
  cancel: "no:",
  animate: "an:",
  /** Opens the effect picker for an image the bot made. */
  effects: "fx:",
  /** Picks one effect from the picker. */
  effect: "fe:",
} as const;

/**
 * Price, then either refuse, ask for confirmation, or go. Nothing is charged until the request
 * runs, and it only runs after this check passes.
 */
export async function startMedia(
  core: BotCore,
  caller: Caller,
  kind: ModelKind,
  prompt: string,
  idempotencyKey: string,
  surface: MediaSurface,
  imageUrl?: string,
): Promise<void> {
  await startPrepared(core, caller, kind, idempotencyKey, surface, `your ${kind === "image" ? "image" : "video"}`, () =>
    core.prepareMedia(caller, kind, prompt, idempotencyKey, imageUrl),
  );
}

/** Same flow as startMedia for a preset video effect on one photo. */
export async function startEffect(core: BotCore, caller: Caller, effect: Effect, imageUrl: string, idempotencyKey: string, surface: MediaSurface): Promise<void> {
  await startPrepared(core, caller, "effect", idempotencyKey, surface, `the ${effect.name} effect`, () =>
    core.prepareEffect(caller, effect, imageUrl, idempotencyKey),
  );
}

async function startPrepared(
  core: BotCore,
  caller: Caller,
  kind: MediaKind,
  idempotencyKey: string,
  surface: MediaSurface,
  what: string,
  prepare: () => Promise<{ prepared: PreparedMedia; modelName: string }>,
): Promise<void> {
  // A double tap or a re-delivered update reuses the same key; one run per key is enough.
  if (!core.claimKey(idempotencyKey)) {
    await surface.status("Already working on this one.");
    return;
  }
  let prepared: PreparedMedia;
  let modelName: string;
  try {
    await surface.status(`Checking the price for ${what}...`);
    ({ prepared, modelName } = await prepare());
  } catch (error) {
    core.releaseKey(idempotencyKey);
    core.log(`quote failed: ${error instanceof Error ? error.name : "error"}`);
    await surface.status(describeError(error));
    return;
  }
  const { decision } = prepared;
  if (decision.kind === "too_expensive" || decision.kind === "over_budget") {
    core.releaseKey(idempotencyKey);
    await surface.status(describeRefusal(decision));
    return;
  }
  if (decision.kind === "confirm") {
    // The key stays claimed while the request waits for Confirm.
    const parked = core.park(caller, kind, prepared, modelName, null);
    await surface.status(confirmText(decision.worst, modelName), [
      { id: `${CALLBACK.confirm}${parked.id}`, label: `Confirm (${formatCredits(decision.worst)})`, style: "primary" },
      { id: `${CALLBACK.cancel}${parked.id}`, label: "Cancel", style: "secondary" },
    ]);
    return;
  }
  await executeMedia(core, prepared, kind, modelName, surface);
}

/** Handles a tap on Confirm or Cancel. Returns a short notice for the tap itself, if any. */
export async function resolvePending(core: BotCore, data: string, user: string, surface: MediaSurface): Promise<string | undefined> {
  const confirm = data.startsWith(CALLBACK.confirm);
  const id = data.slice(CALLBACK.confirm.length);
  const pending = core.takePending(id, user);
  if (pending === "not_yours") return "Only the person who asked can confirm or cancel this.";
  if (!pending) {
    await surface.status("This request has expired. Nothing was charged; send the command again.");
    return undefined;
  }
  if (!confirm) {
    core.releaseKey(pending.prepared.request.idempotencyKey);
    await surface.status("Cancelled. Nothing was charged.");
    return undefined;
  }
  void executeMedia(core, pending.prepared, pending.kind, pending.modelName, surface).catch((error) =>
    core.log(`media run crashed: ${String(error)}`),
  );
  return undefined;
}

export async function executeMedia(core: BotCore, prepared: PreparedMedia, kind: MediaKind, modelName: string, surface: MediaSurface): Promise<void> {
  const worst = prepared.decision.worst;
  const editor = new ThrottledEditor((text) => surface.status(text), surface.progressIntervalMs);
  editor.update(`Submitting...\n${modelName} · up to ${formatCredits(worst)}`);
  try {
    const outcome = await core.media.run(prepared, {
      onAccepted: () => editor.update(progressText("queued", 0, worst, modelName)),
      onProgress: (task, elapsed) => {
        surface.activity?.(kind);
        editor.update(progressText(task.state, elapsed, worst, modelName));
      },
    });
    switch (outcome.kind) {
      case "succeeded": {
        if (outcome.assets.length === 0) {
          await editor.flush(`Finished, but no file came back. Task ${outcome.task.taskId}`);
          return;
        }
        await editor.flush(`Done. Sending the result...`);
        const caption = resultCaption(modelName, outcome.charged, outcome.final, outcome.task.taskId);
        const buttons = kind === "image" ? imageButtons(core, outcome.task.taskId) : [];
        for (const asset of outcome.assets) await surface.deliver(asset, caption, buttons);
        await surface.done();
        return;
      }
      case "failed":
        await editor.flush(describeFailedTask(outcome.task));
        return;
      case "still_running":
        await editor.flush(`${STILL_RUNNING}\nTask ${outcome.taskId}`);
        return;
      case "not_submitted":
        await editor.flush(describeRefusal(outcome.decision));
        return;
      case "unknown":
        await editor.flush(
          "Could not confirm whether the request reached PopNow, so it is counted against today's limit. Check your PopNow account before trying again.",
        );
        return;
    }
  } catch (error) {
    core.log(`media run failed: ${error instanceof Error ? error.name : "error"}`);
    await editor.flush(describeError(error));
  } finally {
    core.releaseKey(prepared.request.idempotencyKey);
  }
}

/** The buttons under an image the bot made: Animate, plus Effects when any are configured. */
export function imageButtons(core: BotCore, taskId: string): Button[] {
  const buttons: Button[] = [{ id: `${CALLBACK.animate}${taskId}`, label: "Animate", style: "secondary" }];
  if (core.effects.length > 0) buttons.push({ id: `${CALLBACK.effects}${taskId}`, label: "Effects", style: "secondary" });
  return buttons;
}

/** Splits text into pieces of at most `limit` characters, preferring paragraph and line breaks. */
export function splitMessage(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0 || parts.length === 0) parts.push(rest);
  return parts;
}
