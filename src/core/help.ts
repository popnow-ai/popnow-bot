import type { BotConfig } from "../config.js";
import { formatCredits } from "./credits.js";

export interface CommandInfo {
  name: string;
  /** Shown in the Telegram command menu and Discord's command picker (max 100 characters). */
  description: string;
}

/**
 * Command names are deliberately not /image, /video, /model or /balance: several popular bots use
 * those, and in a group with more than one bot they would all answer.
 */
export const COMMANDS = {
  pic: { name: "pic", description: "Generate an image from a prompt" },
  vid: { name: "vid", description: "Generate a video from a prompt" },
  animate: { name: "animate", description: "Turn an image into a video (reply to an image)" },
  effect: { name: "effect", description: "Apply a trending video effect to an image" },
  effects: { name: "effects", description: "List the video effects" },
  models: { name: "models", description: "Choose the image and video models" },
  spend: { name: "spend", description: "What you have spent today" },
  report: { name: "report", description: "Report a problem or inappropriate content to the operator" },
  help: { name: "help", description: "How this bot works" },
} as const satisfies Record<string, CommandInfo>;

export const RULES_TEXT = [
  "Before you start:",
  "• Keep it friendly and suitable for everyone: nothing hateful, violent, sexual or harassing.",
  "• Only upload photos you have the right to use. Ask before animating a photo of someone else.",
  "• Never use a real person's likeness to mislead, impersonate or embarrass them.",
  "What you create is your responsibility. Terms: https://popnow.ai/terms · Contact: https://popnow.ai/contact",
].join("\n");

export const CONSENT_LABEL = "I agree";

export function helpText(config: BotConfig, platform: "telegram" | "discord", names: { image: string; video: string; animate: string }, effectCount: number): string {
  const slash = "/";
  const lines = [
    "PopNow bot: AI images and videos, paid from the operator's PopNow credits. Make it pop.",
    "",
    `${slash}pic <prompt> — image (${names.image})`,
    `${slash}vid <prompt> — video (${names.video})`,
    platform === "telegram"
      ? `${slash}animate <motion> — reply to an image to turn it into a video (${names.animate}). Or tap "Animate" under any image the bot made.`
      : `Tap "Animate" under any image the bot made to turn it into a video (${names.animate}).` +
        (config.allowPhotoUploads ? ` Or use ${slash}animate with your own image.` : ""),
  ];
  if (effectCount > 0) {
    lines.push(
      platform === "telegram"
        ? `${slash}effect <name> — reply to an image to apply a video effect, or tap "Effects" under an image the bot made. ${slash}effects lists all ${effectCount}.`
        : `Tap "Effects" under an image the bot made to apply a video effect` +
            (config.allowPhotoUploads ? `, or use ${slash}effect with your own image` : "") +
            `. ${slash}effects lists all ${effectCount}.`,
    );
  }
  lines.push(
    `${slash}models — choose models · ${slash}spend — what you have spent today`,
    `${slash}report <text> — tell the operator about a problem or inappropriate content`,
    "",
    "Credits:",
    `• Every image and video is priced before it runs. Above ${formatCredits(config.spend.confirmAbove)} you are asked to confirm; above ${formatCredits(config.spend.maxPerRequest)} it is refused.`,
    `• Daily limit: ${formatCredits(config.limits.userDaily)} per person, ${formatCredits(config.limits.globalDaily)} for the whole bot (reset 00:00 UTC).`,
    "• A started generation cannot be cancelled. Failed generations are refunded.",
  );
  if (!config.allowPhotoUploads) lines.push("• Using your own uploaded photos is turned off on this bot.");
  return lines.join("\n");
}
