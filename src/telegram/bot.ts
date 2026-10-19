import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import type { Message } from "grammy/types";
import type { TaskOutputAsset } from "popnow";
import { decideAccess, userKey, type ChatContext } from "../core/access.js";
import type { BotCore, Caller } from "../core/bot-core.js";
import { KIND_LABEL, priceLabel } from "../core/catalog.js";
import { MB, TooLargeError, fetchBytes, formatMb, resultFileName, taskIdFromText } from "../core/download.js";
import { effectListText, type Effect } from "../core/effects.js";
import { CALLBACK, resolvePending, splitMessage, startEffect, startMedia, type Button, type MediaSurface } from "../core/flows.js";
import { COMMANDS, CONSENT_LABEL, RULES_TEXT, helpText } from "../core/help.js";
import { idempotencyKey } from "../core/idempotency.js";
import { InputError } from "../core/inputs.js";
import { describeError } from "../core/messages.js";
import type { ModelKind } from "../core/store.js";

const TEXT_LIMIT = 4096;
/** Telegram fetches files from a URL itself up to these sizes (Bot API "Sending files"). */
const URL_LIMIT = { photo: 5 * MB, other: 20 * MB };
/** Multipart upload limits. */
const UPLOAD_LIMIT = { photo: 10 * MB, other: 50 * MB };
const PAGE_SIZE = 8;
const MODEL_KINDS: ModelKind[] = ["image", "video", "animate"];

export interface TelegramHandle {
  stop(): Promise<void>;
}

export interface TelegramOptions {
  /** A self-hosted Bot API server (or a test double). Defaults to https://api.telegram.org. */
  apiRoot?: string;
}

export async function startTelegram(core: BotCore, token: string, options: TelegramOptions = {}): Promise<TelegramHandle> {
  const config = core.config;
  const apiRoot = (options.apiRoot ?? "https://api.telegram.org").replace(/\/+$/, "");
  const bot = new Bot(token, { client: { apiRoot } });
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  await bot.init();
  const botId = bot.botInfo.id;

  // ---- access ---------------------------------------------------------------------------------

  function chatContext(ctx: Context): ChatContext {
    const chat = ctx.chat;
    if (!chat || chat.type === "private") return { kind: "private" };
    return { kind: "group", ids: [String(chat.id)] };
  }

  function callerOf(ctx: Context, owner: boolean): Caller {
    const from = ctx.from!;
    return { user: userKey("telegram", from.id), owner, name: from.first_name || "you" };
  }

  const consentKeyboard = () => new InlineKeyboard().text(CONSENT_LABEL, "consent");

  /** Returns the caller when this person may use the bot here, otherwise explains (in private) and returns undefined. */
  async function admit(ctx: Context, { needsConsent = true } = {}): Promise<Caller | undefined> {
    if (!ctx.from || ctx.from.is_bot) return undefined;
    const decision = decideAccess(config.access, { platform: "telegram", userId: ctx.from.id, chat: chatContext(ctx) });
    if (!decision.allowed) {
      if (decision.reason === "user_not_allowed") {
        await reply(ctx, `This is a private bot. If you know its operator, send them your Telegram user ID: ${ctx.from.id}`);
      } else if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "This bot is not enabled in this chat." }).catch(() => {});
      }
      // Unlisted groups get no answer at all, so the bot stays quiet where nobody approved it.
      return undefined;
    }
    const caller = callerOf(ctx, decision.owner);
    if (needsConsent && core.needsConsent(caller.user)) {
      await reply(ctx, RULES_TEXT, consentKeyboard());
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      return undefined;
    }
    return caller;
  }

  async function reply(ctx: Context, text: string, keyboard?: InlineKeyboard): Promise<Message | undefined> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return undefined;
    const replyTo = ctx.msg?.message_id && !ctx.callbackQuery ? { reply_parameters: { message_id: ctx.msg.message_id, allow_sending_without_reply: true } } : {};
    return bot.api.sendMessage(chatId, text, { ...replyTo, ...(keyboard ? { reply_markup: keyboard } : {}), link_preview_options: { is_disabled: true } });
  }

  function keyboardOf(buttons: Button[] | undefined): InlineKeyboard | undefined {
    if (!buttons || buttons.length === 0) return undefined;
    const keyboard = new InlineKeyboard();
    for (const button of buttons) keyboard.text(button.label, button.id);
    return keyboard;
  }

  function detach(work: Promise<unknown>): void {
    work.catch((error) => core.log(`telegram handler failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  // ---- media surface --------------------------------------------------------------------------

  /** A status message edited in place; created on first use, or reused when given (button taps). */
  function mediaSurface(chatId: number, replyTo: number | undefined, existing?: number): MediaSurface {
    let statusId = existing;
    return {
      progressIntervalMs: config.progressIntervalMs,
      async status(text, buttons) {
        const keyboard = keyboardOf(buttons);
        if (statusId === undefined) {
          const sent = await bot.api.sendMessage(chatId, text, {
            ...(keyboard ? { reply_markup: keyboard } : {}),
            ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
          });
          statusId = sent.message_id;
          return;
        }
        // An empty keyboard removes the Confirm / Cancel buttons once they have been used.
        await bot.api.editMessageText(chatId, statusId, text, { reply_markup: keyboard ?? new InlineKeyboard() }).catch(ignoreNotModified);
      },
      async deliver(asset, caption, buttons) {
        await sendAsset(chatId, asset, caption, keyboardOf(buttons), replyTo);
      },
      async done() {
        if (statusId !== undefined) await bot.api.deleteMessage(chatId, statusId).catch(() => {});
      },
      activity(kind) {
        const action = kind === "image" ? "upload_photo" : "upload_video";
        bot.api.sendChatAction(chatId, action).catch(() => {});
      },
    };
  }

  async function sendAsset(chatId: number, asset: TaskOutputAsset, caption: string, keyboard: InlineKeyboard | undefined, replyTo: number | undefined): Promise<void> {
    const url = asset.url!;
    const mime = asset.mime ?? "";
    const type = mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : "document";
    const common = {
      caption,
      ...(keyboard ? { reply_markup: keyboard } : {}),
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    };
    const send = (file: string | InputFile, as: typeof type) =>
      as === "photo"
        ? bot.api.sendPhoto(chatId, file, common)
        : as === "video"
          ? bot.api.sendVideo(chatId, file, { ...common, supports_streaming: true })
          : bot.api.sendDocument(chatId, file, common);

    // 1. Let Telegram fetch the signed link itself: no bytes pass through this machine.
    const urlLimit = type === "photo" ? URL_LIMIT.photo : URL_LIMIT.other;
    if (asset.bytes === undefined || asset.bytes <= urlLimit) {
      try {
        await send(url, type);
        return;
      } catch (error) {
        core.log(`sending by link failed, uploading instead (${error instanceof GrammyError ? error.description : "error"})`);
      }
    }
    // 2. Download and upload; a large image goes as a file instead of a photo.
    let tooLarge = "";
    try {
      const { bytes } = await fetchBytes(url, UPLOAD_LIMIT.other);
      const name = resultFileName(mime, "result");
      const as = type === "photo" && bytes.byteLength > UPLOAD_LIMIT.photo ? "document" : type;
      try {
        await send(new InputFile(bytes, name), as);
      } catch (error) {
        // Telegram rejects some images as photos (dimensions, format); a file always goes through.
        if (as === "document") throw error;
        await send(new InputFile(bytes, name), "document");
      }
      return;
    } catch (error) {
      if (error instanceof TooLargeError) tooLarge = error.bytes ? ` (${formatMb(error.bytes)})` : "";
      core.log(`upload to Telegram failed: ${error instanceof Error ? error.message : "error"}`);
    }
    // 3. Could not send the file: hand over the link, which expires.
    await bot.api.sendMessage(
      chatId,
      `${caption}\n${tooLarge ? `The file is too large to send here${tooLarge}.` : "The file could not be sent here."} Download it within about 20 minutes:\n${url}`,
      { ...(keyboard ? { reply_markup: keyboard } : {}), link_preview_options: { is_disabled: true } },
    );
  }

  function mediaKey(ctx: Context, action: string): string {
    return idempotencyKey(["tg", botId, ctx.chat!.id, ctx.msg!.message_id, action]);
  }

  function media(ctx: Context, caller: Caller, kind: ModelKind, prompt: string, imageUrl?: string): void {
    const chatId = ctx.chat!.id;
    const replyTo = ctx.msg?.message_id;
    detach(startMedia(core, caller, kind, prompt, mediaKey(ctx, kind), mediaSurface(chatId, replyTo), imageUrl));
  }

  // ---- commands -------------------------------------------------------------------------------

  const names = async (caller: Caller) => {
    const name = (kind: ModelKind) => core.catalog.displayName(core.modelFor(caller.user, kind));
    await Promise.all(MODEL_KINDS.map((kind) => core.catalog.list(kind).catch(() => [])));
    return { image: name("image"), video: name("video"), animate: name("animate") };
  };

  bot.command(["start", COMMANDS.help.name], async (ctx) => {
    const caller = await admit(ctx, { needsConsent: false });
    if (!caller) return;
    await reply(ctx, helpText(config, "telegram", await names(caller), core.effects.length));
    if (core.needsConsent(caller.user)) await reply(ctx, RULES_TEXT, consentKeyboard());
  });

  bot.command(COMMANDS.pic.name, async (ctx) => {
    const caller = await admit(ctx);
    if (!caller) return;
    if (!ctx.match.trim()) return void (await reply(ctx, "Usage: /pic <what to draw>"));
    media(ctx, caller, "image", ctx.match);
  });

  bot.command(COMMANDS.vid.name, async (ctx) => {
    const caller = await admit(ctx);
    if (!caller) return;
    if (!ctx.match.trim()) return void (await reply(ctx, "Usage: /vid <what should happen>"));
    media(ctx, caller, "video", ctx.match);
  });

  bot.command(COMMANDS.animate.name, async (ctx) => animateFromReply(ctx, ctx.match, ctx.msg.reply_to_message));
  bot.command(COMMANDS.effect.name, async (ctx) => effectFromReply(ctx, ctx.match, ctx.msg.reply_to_message));

  bot.command(COMMANDS.effects.name, async (ctx) => {
    const caller = await admit(ctx, { needsConsent: false });
    if (!caller) return;
    for (const part of splitMessage(effectListText(core.effects), TEXT_LIMIT)) await reply(ctx, part);
  });

  // A photo sent with the caption "/animate ..." or "/effect ..." (Telegram does not treat captions as commands).
  bot.on("message:photo", async (ctx, next) => {
    const caption = (ctx.msg.caption ?? "").trim();
    const match = /^\/(animate|effect)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(caption);
    if (!match) return next();
    if (match[1]!.toLowerCase() === "animate") await animateFromReply(ctx, match[2] ?? "", ctx.msg);
    else await effectFromReply(ctx, match[2] ?? "", ctx.msg);
  });

  /** The image a command points at: an image the bot made (by its task), or an uploaded photo when allowed. */
  async function imageFrom(ctx: Context, target: Message | undefined, usage: string): Promise<{ url: string; prompt: string | undefined } | undefined> {
    if (!target) {
      await reply(ctx, usage);
      return undefined;
    }
    const fromBot = target.from?.id === botId;
    const taskId = fromBot ? (taskIdFromText(target.caption) ?? taskFromMarkup(target)) : undefined;
    if (taskId) return core.imageFromTask(taskId);
    if (!config.allowPhotoUploads) {
      await reply(ctx, "Using uploaded photos is turned off on this bot. Use the buttons under an image the bot made.");
      return undefined;
    }
    return { url: await uploadFromMessage(target), prompt: undefined };
  }

  async function animateFromReply(ctx: Context, motion: string, target: Message | undefined): Promise<void> {
    const caller = await admit(ctx);
    if (!caller) return;
    try {
      const image = await imageFrom(ctx, target, 'Reply to an image with /animate <how it should move>, or tap "Animate" under an image the bot made.');
      if (image) media(ctx, caller, "animate", core.motionPrompt(motion, image.prompt), image.url);
    } catch (error) {
      await reply(ctx, describeError(error));
    }
  }

  async function effectFromReply(ctx: Context, query: string, target: Message | undefined): Promise<void> {
    const caller = await admit(ctx);
    if (!caller) return;
    if (core.effects.length === 0) return void (await reply(ctx, "No video effects are set up on this bot."));
    const effect = core.findEffect(query);
    if (!effect) {
      const intro = query.trim() ? `There is no effect called "${query.trim()}".\n\n` : "Usage: reply to an image with /effect <name>.\n\n";
      await reply(ctx, `${intro}${effectListText(core.effects)}`.slice(0, TEXT_LIMIT));
      return;
    }
    try {
      const image = await imageFrom(ctx, target, `Reply to an image with /effect ${effect.id}, or tap "Effects" under an image the bot made.`);
      if (!image) return;
      const chatId = ctx.chat!.id;
      detach(startEffect(core, caller, effect, image.url, mediaKey(ctx, `effect:${effect.id}`), mediaSurface(chatId, ctx.msg?.message_id)));
    } catch (error) {
      await reply(ctx, describeError(error));
    }
  }

  function taskFromMarkup(message: Message): string | undefined {
    for (const row of message.reply_markup?.inline_keyboard ?? []) {
      for (const button of row) {
        if (!("callback_data" in button) || !button.callback_data) continue;
        for (const prefix of [CALLBACK.animate, CALLBACK.effects]) {
          if (button.callback_data.startsWith(prefix)) return button.callback_data.slice(prefix.length);
        }
      }
    }
    return undefined;
  }

  /**
   * Telegram file links contain the bot token, so they must never be handed to PopNow. The bytes
   * are downloaded here and uploaded to PopNow storage instead.
   */
  async function uploadFromMessage(message: Message): Promise<string> {
    const photo = message.photo?.at(-1);
    const document = message.document?.mime_type?.startsWith("image/") ? message.document : undefined;
    const fileId = photo?.file_id ?? document?.file_id;
    if (!fileId) throw new InputError("That message has no image. Reply to a photo.");
    const size = photo?.file_size ?? document?.file_size;
    if (size !== undefined && size > 10 * MB) throw new InputError("That image is larger than 10 MB. Send a smaller one.");
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) throw new InputError("Telegram did not return that file. Send it again.");
    const { bytes, contentType } = await fetchBytes(`${apiRoot}/file/bot${token}/${file.file_path}`, 10 * MB);
    const type = document?.mime_type ?? (contentType.startsWith("image/") ? contentType : "image/jpeg");
    return core.uploadImage(bytes, type);
  }

  bot.command(COMMANDS.models.name, async (ctx) => {
    const caller = await admit(ctx, { needsConsent: false });
    if (!caller) return;
    await reply(ctx, "Which model do you want to change?", kindKeyboard());
  });

  bot.command(COMMANDS.spend.name, async (ctx) => {
    const caller = await admit(ctx, { needsConsent: false });
    if (!caller) return;
    await reply(ctx, await core.spendText(caller));
  });

  bot.command(COMMANDS.report.name, async (ctx) => {
    const caller = await admit(ctx, { needsConsent: false });
    if (!caller) return;
    const text = ctx.match.trim();
    if (!text) return void (await reply(ctx, "Usage: /report <what happened> (you can also reply to the message with /report <text>)"));
    const about = taskIdFromText(ctx.msg.reply_to_message?.caption) ?? taskIdFromText(ctx.msg.reply_to_message?.text);
    const owners = [...config.access.owners.ids].filter((id) => id.startsWith("telegram:") || id.startsWith("*:")).map((id) => id.split(":")[1]!);
    let delivered = 0;
    for (const owner of owners) {
      await bot.api
        .sendMessage(owner, `Report from user ${ctx.from!.id} in chat ${ctx.chat.id}${about ? ` about task ${about}` : ""}:\n${text}`)
        .then(() => delivered++)
        .catch(() => {});
    }
    await reply(ctx, `${delivered > 0 ? "Sent to the operator." : "Could not reach the operator here."} You can also contact PopNow at https://popnow.ai/contact`);
  });

  // Plain text in a private chat: point at the commands.
  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    const caller = await admit(ctx, { needsConsent: false });
    if (!caller) return;
    const unknown = ctx.msg.text.startsWith("/");
    await reply(ctx, unknown ? "Unknown command. Send /help to see what this bot can do." : "Send /pic <prompt> for an image or /vid <prompt> for a video. /help shows everything.");
  });

  // ---- buttons --------------------------------------------------------------------------------

  function kindKeyboard(): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const kind of MODEL_KINDS) keyboard.text(KIND_LABEL[kind], `mk:${kind}:0`).row();
    return keyboard;
  }

  function effectKeyboard(effects: readonly Effect[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    effects.forEach((effect, index) => {
      keyboard.text(effect.name, `${CALLBACK.effect}${index}`);
      if (index % 2 === 1) keyboard.row();
    });
    return keyboard;
  }

  async function modelPage(caller: Caller, kind: ModelKind, page: number): Promise<{ text: string; keyboard: InlineKeyboard }> {
    const models = await core.catalog.list(kind);
    const current = core.modelFor(caller.user, kind);
    const pages = Math.max(1, Math.ceil(models.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(0, page), pages - 1);
    const keyboard = new InlineKeyboard();
    models.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE).forEach((model, offset) => {
      const index = safePage * PAGE_SIZE + offset;
      const price = priceLabel(model);
      keyboard.text(`${model.model === current ? "✓ " : ""}${model.displayName}${price ? ` · ${price}` : ""}`, `mm:${kind}:${index}`).row();
    });
    if (pages > 1) {
      if (safePage > 0) keyboard.text("‹ Previous", `mk:${kind}:${safePage - 1}`);
      if (safePage < pages - 1) keyboard.text("Next ›", `mk:${kind}:${safePage + 1}`);
      keyboard.row();
    }
    keyboard.text("Back", "mk:back:0");
    const text = models.length === 0 ? `No ${KIND_LABEL[kind].toLowerCase()} models are available right now.` : `${KIND_LABEL[kind]} model (page ${safePage + 1} of ${pages}). Current: ${core.catalog.displayName(current)}`;
    return { text, keyboard };
  }

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const message = ctx.callbackQuery.message;
    const chatId = message?.chat.id;

    if (data === "consent") {
      const caller = await admit(ctx, { needsConsent: false });
      if (!caller) return;
      core.giveConsent(caller.user);
      await ctx.answerCallbackQuery({ text: "Thanks!" });
      if (message) await ctx.editMessageText(`${RULES_TEXT}\n\nAccepted. Send /help to see what you can do.`).catch(() => {});
      return;
    }

    if (data.startsWith(CALLBACK.confirm) || data.startsWith(CALLBACK.cancel)) {
      const caller = await admit(ctx);
      if (!caller || !message || chatId === undefined) return;
      const surface = mediaSurface(chatId, message.reply_to_message?.message_id, message.message_id);
      const notice = await resolvePending(core, data, caller.user, surface);
      await ctx.answerCallbackQuery(notice ? { text: notice, show_alert: true } : undefined).catch(() => {});
      return;
    }

    if (data.startsWith(CALLBACK.animate)) {
      const caller = await admit(ctx);
      if (!caller || !message || chatId === undefined) return;
      await ctx.answerCallbackQuery({ text: "Pricing the video..." }).catch(() => {});
      const taskId = data.slice(CALLBACK.animate.length);
      try {
        const source = await core.imageFromTask(taskId);
        const key = idempotencyKey(["tg", botId, chatId, message.message_id, "animate", ctx.from.id]);
        detach(startMedia(core, caller, "animate", core.motionPrompt(undefined, source.prompt), key, mediaSurface(chatId, message.message_id), source.url));
      } catch (error) {
        await bot.api.sendMessage(chatId, describeError(error), { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
      }
      return;
    }

    if (data.startsWith(CALLBACK.effects)) {
      // The picker replies to the image, so a tap on an effect can find the image again.
      const caller = await admit(ctx);
      if (!caller || !message || chatId === undefined) return;
      await ctx.answerCallbackQuery().catch(() => {});
      await bot.api.sendMessage(chatId, "Pick a video effect for this image:", {
        reply_markup: effectKeyboard(core.effects),
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      });
      return;
    }

    if (data.startsWith(CALLBACK.effect)) {
      const caller = await admit(ctx);
      if (!caller || !message || chatId === undefined) return;
      const effect = core.effects[Number(data.slice(CALLBACK.effect.length))];
      const image = message.reply_to_message;
      const taskId = image ? (taskIdFromText(image.caption) ?? taskFromMarkup(image)) : undefined;
      if (!effect || !taskId) {
        await ctx.answerCallbackQuery({ text: "That picker is out of date. Tap Effects under the image again.", show_alert: true }).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery({ text: `Pricing ${effect.name}...` }).catch(() => {});
      try {
        const source = await core.imageFromTask(taskId);
        const key = idempotencyKey(["tg", botId, chatId, message.message_id, "effect", effect.id, ctx.from.id]);
        detach(startEffect(core, caller, effect, source.url, key, mediaSurface(chatId, image!.message_id, message.message_id)));
      } catch (error) {
        await ctx.editMessageText(describeError(error)).catch(() => {});
      }
      return;
    }

    if (data.startsWith("mk:") || data.startsWith("mm:")) {
      const caller = await admit(ctx, { needsConsent: false });
      if (!caller) return;
      const [action, kindRaw, numberRaw] = data.split(":");
      if (kindRaw === "back") {
        await ctx.editMessageText("Which model do you want to change?", { reply_markup: kindKeyboard() }).catch(ignoreNotModified);
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }
      const kind = kindRaw as ModelKind;
      if (!MODEL_KINDS.includes(kind)) return void (await ctx.answerCallbackQuery());
      const number = Number(numberRaw) || 0;
      try {
        if (action === "mm") {
          const chosen = (await core.catalog.list(kind))[number];
          if (!chosen) {
            await ctx.answerCallbackQuery({ text: "The model list changed; please pick again." });
          } else {
            core.setModel(caller.user, kind, chosen.model);
            await ctx.answerCallbackQuery({ text: `${KIND_LABEL[kind]}: ${chosen.displayName}` });
          }
        } else {
          await ctx.answerCallbackQuery().catch(() => {});
        }
        const page = action === "mm" ? Math.floor(number / PAGE_SIZE) : number;
        const view = await modelPage(caller, kind, page);
        await ctx.editMessageText(view.text, { reply_markup: view.keyboard }).catch(ignoreNotModified);
      } catch (error) {
        await ctx.answerCallbackQuery({ text: describeError(error).slice(0, 190), show_alert: true }).catch(() => {});
      }
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});
  });

  bot.catch((error) => {
    core.log(`telegram update ${error.ctx.update.update_id} failed: ${error.error instanceof Error ? error.error.message : String(error.error)}`);
  });

  const menu = Object.values(COMMANDS).filter((command) => core.effects.length > 0 || (command.name !== "effect" && command.name !== "effects"));
  await bot.api.setMyCommands(menu.map(({ name, description }) => ({ command: name, description })));

  // Long polling: no public address, no webhook secret, no TLS to set up.
  let stopping = false;
  bot
    .start({
      allowed_updates: ["message", "callback_query"],
      onStart: (info) => core.log(`Telegram bot @${info.username} is running`),
    })
    .catch((error) => {
      // Stopping aborts the poll in flight; anything else means polling has ended for good.
      if (stopping) return;
      core.log(`Telegram polling stopped: ${error instanceof Error ? error.message : String(error)}`);
      // Exit so Docker restarts the bot. A "Conflict" here means a second copy is running with the same token.
      process.exit(1);
    });

  return {
    async stop() {
      stopping = true;
      await bot.stop();
    },
  };
}

function ignoreNotModified(error: unknown): void {
  if (error instanceof GrammyError && error.description.includes("message is not modified")) return;
  throw error;
}
