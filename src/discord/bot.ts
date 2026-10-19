import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  StringSelectMenuBuilder,
  type Attachment,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { decideAccess, userKey, type ChatContext } from "../core/access.js";
import type { BotCore, Caller } from "../core/bot-core.js";
import { KIND_LABEL, priceLabel } from "../core/catalog.js";
import { formatMb, resultFileName } from "../core/download.js";
import { effectListText } from "../core/effects.js";
import { CALLBACK, resolvePending, splitMessage, startEffect, startMedia, type Button, type MediaSurface } from "../core/flows.js";
import { CONSENT_LABEL, RULES_TEXT, helpText } from "../core/help.js";
import { idempotencyKey } from "../core/idempotency.js";
import { InputError } from "../core/inputs.js";
import { describeError } from "../core/messages.js";
import type { ModelKind } from "../core/store.js";
import { commandDefinitions } from "./commands.js";

const TEXT_LIMIT = 2000;
/** Interaction tokens last 15 minutes; after that, results go out as ordinary channel messages. */
const TOKEN_LIFETIME_MS = 14 * 60_000;
const MODEL_KINDS: ModelKind[] = ["image", "video", "animate"];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export interface DiscordHandle {
  stop(): Promise<void>;
}

export async function startDiscord(core: BotCore, token: string): Promise<DiscordHandle> {
  const config = core.config;
  // Slash commands, buttons and menus arrive as interactions; no message content is read.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  // ---- access ---------------------------------------------------------------------------------

  function chatContext(guildId: string | null, channel: { id: string; parentId?: string | null } | null): ChatContext {
    if (!guildId) return { kind: "private" };
    const ids = [guildId];
    if (channel) ids.unshift(channel.id);
    if (channel?.parentId) ids.splice(1, 0, channel.parentId);
    return { kind: "group", ids };
  }

  function consentRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("consent").setLabel(CONSENT_LABEL).setStyle(ButtonStyle.Primary));
  }

  async function admitInteraction(interaction: RepliableInteraction, need: { consent?: boolean } = {}): Promise<Caller | undefined> {
    const user = interaction.user;
    if (user.bot) return undefined;
    const channel = interaction.channel as { id: string; parentId?: string | null } | null;
    const decision = decideAccess(config.access, { platform: "discord", userId: user.id, chat: chatContext(interaction.guildId, channel) });
    if (!decision.allowed) {
      const content =
        decision.reason === "user_not_allowed"
          ? `This is a private bot. If you know its operator, send them your Discord user ID: ${user.id}`
          : "This bot is not enabled in this channel. The operator can add the channel or server ID to ALLOWED_CHAT_IDS.";
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      return undefined;
    }
    const caller: Caller = { user: userKey("discord", user.id), owner: decision.owner, name: user.displayName || user.username };
    if (need.consent !== false && core.needsConsent(caller.user)) {
      await interaction.reply({ content: RULES_TEXT, flags: MessageFlags.Ephemeral, components: [consentRow()] });
      return undefined;
    }
    return caller;
  }

  function rowsOf(buttons: Button[] | undefined): ActionRowBuilder<ButtonBuilder>[] {
    if (!buttons || buttons.length === 0) return [];
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const button of buttons) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(button.id)
          .setLabel(button.label)
          .setStyle(button.style === "primary" ? ButtonStyle.Primary : button.style === "danger" ? ButtonStyle.Danger : ButtonStyle.Secondary),
      );
    }
    return [row];
  }

  function detach(work: Promise<unknown>): void {
    work.catch((error) => core.log(`discord handler failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  // ---- media surface --------------------------------------------------------------------------

  /** Status and results on an interaction's reply; falls back to channel messages once the token has expired. */
  function mediaSurface(interaction: RepliableInteraction): MediaSurface {
    const startedAt = Date.now();
    const expired = () => Date.now() - startedAt > TOKEN_LIFETIME_MS;
    let delivered = 0;
    return {
      progressIntervalMs: Math.max(config.progressIntervalMs, 5000),
      async status(text, buttons) {
        if (expired()) return;
        await interaction.editReply({ content: text, components: rowsOf(buttons), files: [] });
      },
      async deliver(asset, caption, buttons) {
        const limit = interaction.attachmentSizeLimit || 10 * 1024 * 1024;
        const content = expired() ? `<@${interaction.user.id}> ${caption}` : caption;
        const components = rowsOf(buttons);
        const tooBig = asset.bytes !== undefined && asset.bytes > limit;
        const send = async (payload: { content: string; files?: AttachmentBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }) => {
          if (expired()) {
            const channel = interaction.channel;
            if (channel && "send" in channel) await channel.send(payload);
          } else if (delivered === 0) await interaction.editReply(payload);
          else await interaction.followUp(payload);
          delivered += 1;
        };
        if (!tooBig) {
          try {
            // discord.js downloads the signed link and uploads it as an attachment.
            const file = new AttachmentBuilder(asset.url!, { name: resultFileName(asset.mime, "result") });
            await send({ content, files: [file], components });
            return;
          } catch (error) {
            core.log(`discord attachment failed: ${error instanceof Error ? error.message : "error"}`);
          }
        }
        const size = asset.bytes ? ` (${formatMb(asset.bytes)})` : "";
        await send({ content: `${content}\nThe file is too large to attach here${size}. Download it within about 20 minutes: ${asset.url}`, components });
      },
      async done() {},
    };
  }

  /** Discord attachment links are signed and expire; the bytes go to PopNow storage instead of the link. */
  async function uploadAttachment(attachment: Attachment): Promise<string> {
    const type = attachment.contentType?.split(";")[0] ?? "";
    if (!IMAGE_TYPES.includes(type)) throw new InputError("Attach a JPEG, PNG or WebP image.");
    if (attachment.size > 10 * 1024 * 1024) throw new InputError("That image is larger than 10 MB.");
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return core.uploadImage(new Uint8Array(await response.arrayBuffer()), type);
  }

  // ---- slash commands -------------------------------------------------------------------------

  async function onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = interaction.commandName;
    const key = (action: string) => idempotencyKey(["dc", interaction.applicationId, interaction.id, action]);

    if (name === "pic" || name === "vid") {
      const caller = await admitInteraction(interaction);
      if (!caller) return;
      const kind: ModelKind = name === "pic" ? "image" : "video";
      await interaction.deferReply();
      detach(startMedia(core, caller, kind, interaction.options.getString("prompt", true), key(kind), mediaSurface(interaction)));
      return;
    }

    if (name === "animate" || name === "effect") {
      const caller = await admitInteraction(interaction);
      if (!caller) return;
      if (!config.allowPhotoUploads) {
        await interaction.reply({ content: "Using uploaded images is turned off on this bot.", flags: MessageFlags.Ephemeral });
        return;
      }
      const effect = name === "effect" ? core.findEffect(interaction.options.getString("effect", true)) : undefined;
      if (name === "effect" && !effect) {
        await interaction.reply({ content: "No effect with that name. Start typing and pick one from the list.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply();
      try {
        const uri = await uploadAttachment(interaction.options.getAttachment("image", true));
        if (effect) {
          detach(startEffect(core, caller, effect, uri, key(`effect:${effect.id}`), mediaSurface(interaction)));
        } else {
          const prompt = core.motionPrompt(interaction.options.getString("motion") ?? undefined, undefined);
          detach(startMedia(core, caller, "animate", prompt, key("animate"), mediaSurface(interaction), uri));
        }
      } catch (error) {
        await interaction.editReply({ content: describeError(error) });
      }
      return;
    }

    const caller = await admitInteraction(interaction, { consent: false });
    if (!caller) return;
    const ephemeral = (content: string) => interaction.reply({ content: clip(content), flags: MessageFlags.Ephemeral });

    switch (name) {
      case "help": {
        const label = (kind: ModelKind) => core.catalog.displayName(core.modelFor(caller.user, kind));
        await Promise.all(MODEL_KINDS.map((kind) => core.catalog.list(kind).catch(() => [])));
        await ephemeral(helpText(config, "discord", { image: label("image"), video: label("video"), animate: label("animate") }, core.effects.length));
        return;
      }
      case "effects": {
        const [first, ...rest] = splitMessage(effectListText(core.effects), TEXT_LIMIT);
        await ephemeral(first!);
        for (const part of rest) await interaction.followUp({ content: part, flags: MessageFlags.Ephemeral });
        return;
      }
      case "spend":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply({ content: await core.spendText(caller) });
        return;
      case "models": {
        const kind = interaction.options.getString("kind") as ModelKind | null;
        const model = interaction.options.getString("model");
        if (!kind || !model) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await Promise.all(MODEL_KINDS.map((item) => core.catalog.list(item).catch(() => [])));
          const lines = MODEL_KINDS.map((item) => `• ${KIND_LABEL[item]}: ${core.catalog.displayName(core.modelFor(caller.user, item))}`);
          await interaction.editReply({ content: `Your models:\n${lines.join("\n")}\n\nChange one with /models kind:<kind> model:<name>.` });
          return;
        }
        const available = await core.catalog.list(kind);
        const chosen = available.find((item) => item.model === model);
        if (!chosen) return void (await ephemeral("That model is not available for this. Start typing and pick one from the list."));
        core.setModel(caller.user, kind, chosen.model);
        await ephemeral(`${KIND_LABEL[kind]} model set to ${chosen.displayName} (${priceLabel(chosen)}).`);
        return;
      }
      case "report": {
        const text = interaction.options.getString("text", true);
        let delivered = 0;
        for (const id of config.access.owners.ids) {
          const [platform, ownerId] = id.split(":");
          if (platform !== "discord" && platform !== "*") continue;
          try {
            const owner = await client.users.fetch(ownerId!);
            await owner.send(clip(`Report from <@${interaction.user.id}> (${interaction.user.id}) in ${interaction.guildId ? `<#${interaction.channelId}>` : "a DM"}:\n${text}`));
            delivered += 1;
          } catch {
            // The owner may not share a server with the bot or may have DMs closed.
          }
        }
        await ephemeral(`${delivered > 0 ? "Sent to the operator." : "Could not reach the operator."} You can also contact PopNow at https://popnow.ai/contact`);
        return;
      }
    }
  }

  async function onAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    const typed = String(focused.value).toLowerCase();
    if (interaction.commandName === "effect") {
      const matches = core.effects.filter((item) => item.name.toLowerCase().includes(typed) || item.id.includes(typed)).slice(0, 25);
      await interaction.respond(matches.map((item) => ({ name: `${item.name}: ${item.description}`.slice(0, 100), value: item.id })));
      return;
    }
    if (interaction.commandName === "models") {
      const kind = (interaction.options.getString("kind") ?? "image") as ModelKind;
      const models = MODEL_KINDS.includes(kind) ? await core.catalog.list(kind).catch(() => []) : [];
      const matches = models.filter((item) => item.displayName.toLowerCase().includes(typed) || item.model.includes(typed)).slice(0, 25);
      await interaction.respond(
        matches.map((item) => {
          const price = priceLabel(item);
          return { name: `${item.displayName}${price ? ` · ${price}` : ""}`.slice(0, 100), value: item.model };
        }),
      );
    }
  }

  // ---- buttons and menus ----------------------------------------------------------------------

  async function onButton(interaction: ButtonInteraction): Promise<void> {
    const data = interaction.customId;
    if (data === "consent") {
      const caller = await admitInteraction(interaction, { consent: false });
      if (!caller) return;
      core.giveConsent(caller.user);
      await interaction.update({ content: `${RULES_TEXT}\n\nAccepted. Run your command again.`, components: [] });
      return;
    }
    if (data.startsWith(CALLBACK.confirm) || data.startsWith(CALLBACK.cancel)) {
      const caller = await admitInteraction(interaction);
      if (!caller) return;
      await interaction.deferUpdate();
      // resolvePending checks that the person tapping is the person who asked.
      const notice = await resolvePending(core, data, caller.user, mediaSurface(interaction));
      if (notice) await interaction.followUp({ content: notice, flags: MessageFlags.Ephemeral });
      return;
    }
    if (data.startsWith(CALLBACK.animate)) {
      const caller = await admitInteraction(interaction);
      if (!caller) return;
      await interaction.deferReply();
      try {
        const source = await core.imageFromTask(data.slice(CALLBACK.animate.length));
        const key = idempotencyKey(["dc", interaction.applicationId, interaction.message.id, "animate", interaction.user.id]);
        detach(startMedia(core, caller, "animate", core.motionPrompt(undefined, source.prompt), key, mediaSurface(interaction), source.url));
      } catch (error) {
        await interaction.editReply({ content: describeError(error) });
      }
      return;
    }
    if (data.startsWith(CALLBACK.effects)) {
      const caller = await admitInteraction(interaction);
      if (!caller) return;
      const taskId = data.slice(CALLBACK.effects.length);
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`${CALLBACK.effect}${taskId}`)
        .setPlaceholder("Pick a video effect")
        .addOptions(core.effects.slice(0, 25).map((effect) => ({ label: effect.name.slice(0, 100), description: effect.description.slice(0, 100), value: effect.id })));
      await interaction.reply({
        content: "Pick a video effect for this image:",
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  async function onSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const data = interaction.customId;
    if (!data.startsWith(CALLBACK.effect)) return;
    const caller = await admitInteraction(interaction);
    if (!caller) return;
    const effect = core.findEffect(interaction.values[0] ?? "");
    if (!effect) {
      await interaction.reply({ content: "That effect is no longer available.", flags: MessageFlags.Ephemeral });
      return;
    }
    // The result is posted in the channel; the ephemeral picker stays where it is.
    await interaction.deferReply();
    try {
      const source = await core.imageFromTask(data.slice(CALLBACK.effect.length));
      const key = idempotencyKey(["dc", interaction.applicationId, interaction.id, "effect", effect.id]);
      detach(startEffect(core, caller, effect, source.url, key, mediaSurface(interaction)));
    } catch (error) {
      await interaction.editReply({ content: describeError(error) });
    }
  }

  // ---- events ---------------------------------------------------------------------------------

  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    const work = interaction.isChatInputCommand()
      ? onCommand(interaction)
      : interaction.isAutocomplete()
        ? onAutocomplete(interaction)
        : interaction.isButton()
          ? onButton(interaction)
          : interaction.isStringSelectMenu()
            ? onSelect(interaction)
            : Promise.resolve();
    work.catch(async (error) => {
      core.log(`discord interaction failed: ${error instanceof Error ? error.message : String(error)}`);
      if (interaction.isRepliable()) {
        const content = describeError(error);
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => {});
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    });
  });

  client.once(Events.ClientReady, async (ready) => {
    core.log(`Discord bot ${ready.user.tag} is running`);
    try {
      const definitions = commandDefinitions(config, { effects: core.effects.length > 0 });
      if (config.discordGuildId) await ready.application.commands.set(definitions, config.discordGuildId);
      else await ready.application.commands.set(definitions);
      core.log(`Registered ${definitions.length} Discord commands${config.discordGuildId ? " on one server" : " globally"}`);
    } catch (error) {
      core.log(`Registering Discord commands failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  await client.login(token);
  return {
    async stop() {
      await client.destroy();
    },
  };
}

function clip(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 3)}...` : text;
}
