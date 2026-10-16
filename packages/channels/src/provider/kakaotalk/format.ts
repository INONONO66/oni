import type { RenderPolicy } from "../contract.js";

/**
 * KakaoTalk messages are plain text: markdown goes out as written, and a
 * message is cut well under the platform's own limit.
 */
export const KAKAOTALK_RENDER = {
  renderMarkdown: (markdown: string) => markdown,
  messageLimit: 4000,
} as const satisfies RenderPolicy;
