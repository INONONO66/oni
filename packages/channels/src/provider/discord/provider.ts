import { kernelDeliveryReceipt } from "../../support/deliver.js";
import { z } from "zod";
import type { ChannelProvider } from "../contract.js";
import { DISCORD_MEDIA_LIMITS, DISCORD_RENDER } from "./format.js";
import { DiscordAdapter } from "./surface.js";

interface DiscordCredentials {
  /** Bot token from the developer portal. */
  readonly token: string;
}

/**
 * Discord: one bot token over the gateway socket, DM delivery by user id.
 * Operator precondition the credential cannot carry: the MESSAGE CONTENT
 * gateway intent must be enabled in the developer portal, or every inbound
 * `content` arrives empty.
 */
export const DiscordProvider: ChannelProvider<DiscordCredentials, "discord"> = {
  id: "discord",
  ingest: "socket",
  capabilities: {
    deliver: true,
    webhook: false,
    render: DISCORD_RENDER,
    media: DISCORD_MEDIA_LIMITS,
    react: true,
    typing: true,
  },
  credentials: z.object({ token: z.string().min(1) }).strict(),
  settings: z.record(z.string(), z.never()),
  preconditions: [
    "MESSAGE CONTENT gateway intent enabled in the developer portal",
    "bot invited to the target guild with read/send permissions",
  ],
  create(credentials, config, publish, options) {
    const surface = new DiscordAdapter(credentials.token, config, publish, options);
    return {
      surface,
      deliveryRoute: (externalId, payload, idempotencyKey, conversation) =>
        surface
          .deliver(externalId, payload, idempotencyKey, conversation)
          .then(kernelDeliveryReceipt),
      // POST /channels/{id}/typing shows the indicator for about ten seconds.
      typingRoute: {
        everyMs: 8_000,
        open: (externalId, conversation) => surface.openTyping(externalId, conversation),
        pulse: (conversation) => surface.typing(conversation),
      },
    };
  },
};
