import { kernelDeliveryReceipt } from "../../support/deliver.js";
import { DeliveryNotSent } from "../../errors.js";
import { z } from "zod";
import type { ChannelProvider } from "../contract.js";
import { GitHubAdapter } from "./surface.js";

interface GitHubCredentials {
  /** HMAC secret verifying webhook deliveries — the one required field. */
  readonly secret: string;
  /** API token for posting reply comments; absent leaves the channel ingress-only. */
  readonly token?: string;
  /** Application credential hint; webhook normalization does not filter bot senders. */
  readonly botUsername?: string;
}

/** GitHub: webhook ingress (issues / issue comments), replies as comments. */
export const GitHubProvider: ChannelProvider<GitHubCredentials, "github"> = {
  id: "github",
  ingest: "webhook",
  capabilities: {
    deliver: true,
    webhook: true,
    // GitHub renders markdown natively and comments carry no driver-enforced limit.
    render: { renderMarkdown: (markdown: string) => markdown, messageLimit: null,
      capabilities: {
        Stack: "text",
        Markdown: "text", Code: "text", Table: "text", Image: "text", File: "text",
        Buttons: "text", Button: "text", Card: "text", Carousel: "text", Poll: "text",
        Status: "text", Divider: "text", Context: "text",
      },
    },
    media: false,
    react: false,
    typing: false,
  },
  credentials: z
    .object({
      secret: z.string().min(1),
      token: z.string().min(1).optional(),
      botUsername: z.string().min(1).optional(),
    })
    .strict(),
  settings: z.record(z.string(), z.never()),
  preconditions: [
    "repository webhook posts issues/issue_comment events to the public endpoint with the shared secret",
  ],
  create(credentials, config, publish, options) {
    const surface = new GitHubAdapter(
      credentials.secret,
      config,
      publish,
      { now: options.now, id: options.id, run: options.run },
      credentials.token,
    );
    return {
      surface,
      deliveryRoute: async (externalId, payload, key, conversation) => {
        if (conversation !== undefined)
          throw new DeliveryNotSent({
            operation: "github.deliver",
            cause: `github cannot post into conversation ${conversation.channelId}; only direct delivery`,
          });
        return kernelDeliveryReceipt(await surface.deliver(externalId, payload, key));
      },
      webhookHandler: (request) => surface.handleWebhook(request),
    };
  },
};
