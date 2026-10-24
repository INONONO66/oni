import { renderDiscordMarkdown } from "../../support/format/discord.js";
import type { MediaLimits, RenderPolicy } from "../contract.js";

/**
 * Discord outbound policy — single source: the provider declares it and the
 * surface applies it. 2000 is the message content limit for bots.
 */
export const DISCORD_RENDER = {
  renderMarkdown: renderDiscordMarkdown,
  messageLimit: 2000,
} as const satisfies RenderPolicy;

export const DISCORD_MEDIA_LIMITS = {
  imageBytes: 20 * 1024 * 1024,
  fileBytes: 20 * 1024 * 1024,
  audioBytes: 20 * 1024 * 1024,
  videoBytes: 20 * 1024 * 1024,
  captionLength: 2000,
} as const satisfies MediaLimits;
