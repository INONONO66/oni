import { renderTelegramMarkdown } from "../../support/format/telegram.js";
import type { MediaLimits, RenderPolicy } from "../contract.js";

/**
 * Telegram outbound policy — single source: the provider declares it and the
 * surface applies it. 4096 is the Bot API `sendMessage` text limit.
 */
export const TELEGRAM_RENDER = {
  renderMarkdown: renderTelegramMarkdown,
  messageLimit: 4096,
} as const satisfies RenderPolicy;

export const TELEGRAM_MEDIA_LIMITS = {
  imageBytes: 10_000_000,
  fileBytes: 50_000_000,
  captionLength: 1024,
} as const satisfies MediaLimits;
