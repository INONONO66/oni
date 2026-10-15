import type { MediaLimits, RenderPolicy } from "../contract.js";

/**
 * Slack outbound policy — single source: the provider declares it and the
 * surface applies it. Slack accepts the text as-is (mrkdwn), so the dialect
 * mapping is identity; 4000 is the `chat.postMessage` text guidance limit.
 */
export const SLACK_RENDER = {
  renderMarkdown: (markdown: string) => markdown,
  messageLimit: 4000,
  capabilities: {
    Markdown: "native", Code: "native", Table: "native", Image: "native", File: "native",
    Buttons: "native", Button: "native", Card: "native",
    Carousel: "downgrade:carousel-to-sequence", Poll: "downgrade:poll-to-buttons",
    Status: "native", Divider: "native", Context: "native",
  },
} as const satisfies RenderPolicy;

export const SLACK_MEDIA_LIMITS = {
  imageBytes: 1024 * 1024 * 1024,
  fileBytes: 1024 * 1024 * 1024,
  captionLength: 4000,
} as const satisfies MediaLimits;
