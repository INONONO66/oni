import type { MediaLimits, RenderPolicy } from "../contract.js";

/**
 * KakaoTalk messages are plain text: markdown goes out as written, and a
 * message is cut well under the platform's own limit.
 */
export const KAKAOTALK_RENDER = {
  renderMarkdown: (markdown: string) => markdown,
  messageLimit: 4000,
} as const satisfies RenderPolicy;

/**
 * Declared, not platform-verified: the SDK's LOCO upload enforces no size
 * cap of its own. A caption goes out as the text message after the upload.
 */
export const KAKAOTALK_MEDIA_LIMITS = {
  imageBytes: 10_000_000,
  fileBytes: 50_000_000,
  audioBytes: 50_000_000,
  videoBytes: 50_000_000,
  captionLength: KAKAOTALK_RENDER.messageLimit,
} as const satisfies MediaLimits;
