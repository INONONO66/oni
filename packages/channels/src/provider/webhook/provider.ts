import { z } from "zod";
import type { ChannelProvider } from "../contract";
import { WebhookAdapter } from "./surface";
import { WebhookCredentials, type SecretRefPort } from "./types";

/** A deployment binds the secret reader when constructing this provider. */
export function createWebhookProvider(
  resolveSecret: SecretRefPort,
): ChannelProvider<WebhookCredentials, "webhook"> {
  return {
    id: "webhook",
    ingest: "webhook",
    capabilities: {
      deliver: false,
      webhook: true,
      render: { renderMarkdown: (markdown: string) => markdown, messageLimit: null },
      media: false,
      react: false,
      typing: false,
      voice: false,
    },
    credentials: WebhookCredentials,
    settings: z.record(z.string(), z.never()),
    preconditions: ["X-Signature sha256 HMAC and an installed secretRef are required"],
    create(credentials, config, publish, options) {
      const surface = new WebhookAdapter(credentials, config, publish, options, resolveSecret);
      return { surface, webhookHandler: (request) => surface.handleWebhook(request) };
    },
  };
}

/** Provisioning binds a real secret reader before enabling ingress. */
export const WebhookProvider = createWebhookProvider(async () => undefined);
