import { kernelDeliveryReceipt } from "../../support/deliver.js";
import { z } from "zod";
import type { ChannelProvider } from "../contract.js";
import { SLACK_RENDER } from "./format.js";
import { SlackAdapter } from "./surface.js";

interface SlackCredentials {
  /** Bot token (`xoxb-`): identity, posting, DMs. */
  readonly botToken: string;
  /** App-level token (`xapp-`) with `connections:write`: opens the Socket Mode URL, nothing else. */
  readonly appToken: string;
}

/**
 * Slack over Socket Mode: two tokens by platform design, no public HTTP
 * ingress. Endpoint keys are workspace-mandatory — externalIds are
 * `TEAM:USER` pairs because slack user ids are only unique per workspace
 * (docs/provisioning-and-providers.md §endpoint-keys). Operator precondition
 * the credentials cannot carry: Socket Mode enabled plus the
 * `message.channels`/`message.im` event subscriptions and
 * `chat:write`/`im:write` bot scopes.
 */
export const SlackProvider: ChannelProvider<SlackCredentials, "slack"> = {
  id: "slack",
  ingest: "socket",
  capabilities: { deliver: true, webhook: false, render: SLACK_RENDER },
  credentials: z
    .object({
      botToken: z.string().startsWith("xoxb-"),
      appToken: z.string().startsWith("xapp-"),
    })
    .strict(),
  settings: z.record(z.string(), z.never()),
  preconditions: [
    "Socket Mode enabled with an app-level token granted connections:write",
    "event subscriptions: message.channels and message.im",
    "bot scopes: chat:write, im:write, app_mentions:read",
    "bot invited to the target channels",
  ],
  create(credentials, config, publish, options) {
    const surface = new SlackAdapter(credentials, config, publish, options);
    return {
      surface,
      deliveryRoute: (externalId, body, idempotencyKey, conversation) =>
        surface.deliver(externalId, body, idempotencyKey, conversation).then(kernelDeliveryReceipt),
    };
  },
};
