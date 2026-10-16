import type { RenderPolicy } from "../contract.js";

/**
 * Instagram direct messages are plain text: markdown goes out as written,
 * and a message is cut at the inbox's own limit.
 */
export const INSTAGRAM_RENDER = {
  renderMarkdown: (markdown: string) => markdown,
  messageLimit: 1000,
} as const satisfies RenderPolicy;
