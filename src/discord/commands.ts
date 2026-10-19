import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { BotConfig } from "../config.js";
import { COMMANDS } from "../core/help.js";

type CommandBody = RESTPostAPIChatInputApplicationCommandsJSONBody;

/** Slash command definitions. Commands that need an uploaded image exist only when ALLOW_PHOTO_UPLOADS is on. */
export function commandDefinitions(config: BotConfig, options: { effects: boolean }): CommandBody[] {
  const base: Pick<CommandBody, "type" | "contexts" | "integration_types"> = {
    type: ApplicationCommandType.ChatInput,
    contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
    integration_types: [ApplicationIntegrationType.GuildInstall],
  };
  const prompt = (description: string) => ({
    type: ApplicationCommandOptionType.String as const,
    name: "prompt",
    description,
    required: true,
    max_length: 2000,
  });
  const image = {
    type: ApplicationCommandOptionType.Attachment as const,
    name: "image",
    description: "A JPEG, PNG or WebP image (max 10 MB)",
    required: true,
  };

  const commands: CommandBody[] = [
    { ...base, ...COMMANDS.pic, options: [prompt("What to draw")] },
    { ...base, ...COMMANDS.vid, options: [prompt("What should happen in the video")] },
  ];
  if (config.allowPhotoUploads) {
    commands.push({
      ...base,
      ...COMMANDS.animate,
      description: "Turn your own image into a video",
      options: [image, { type: ApplicationCommandOptionType.String, name: "motion", description: "How it should move", required: false, max_length: 2000 }],
    });
  }
  if (options.effects) {
    if (config.allowPhotoUploads) {
      commands.push({
        ...base,
        ...COMMANDS.effect,
        options: [
          { type: ApplicationCommandOptionType.String, name: "effect", description: "Start typing an effect name", required: true, autocomplete: true },
          image,
        ],
      });
    }
    commands.push({ ...base, ...COMMANDS.effects });
  }
  commands.push(
    {
      ...base,
      ...COMMANDS.models,
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "kind",
          description: "Which model to change",
          required: false,
          choices: [
            { name: "Image", value: "image" },
            { name: "Video", value: "video" },
            { name: "Animate (image to video)", value: "animate" },
          ],
        },
        { type: ApplicationCommandOptionType.String, name: "model", description: "Start typing a model name", required: false, autocomplete: true },
      ],
    },
    { ...base, ...COMMANDS.spend },
    {
      ...base,
      ...COMMANDS.report,
      options: [{ type: ApplicationCommandOptionType.String, name: "text", description: "What happened (include the task ID if you have it)", required: true, max_length: 1500 }],
    },
    { ...base, ...COMMANDS.help },
  );
  return commands;
}
