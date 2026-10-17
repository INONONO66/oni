import { kernelDeliveryReceipt } from "../../support/deliver.js";
import { z } from "zod";
import type { ChannelProvider, OwnerArm } from "../contract.js";
import { DISCORD_MEDIA_LIMITS, DISCORD_RENDER } from "./format.js";
import { DiscordOwnerAdapter } from "./owner.js";
import { type DiscordOwnerSdk, discordOwnerSdk } from "./owner-sdk.js";
import { type DiscordSdk, discordSdk } from "./sdk.js";
import { DiscordAdapter } from "./surface.js";

interface DiscordCredentials {
  /** Bot token from the developer portal. */
  readonly token: string;
}

/** The Owner's own account session (#1569): the account token the remote-auth (QR) login produced. */
interface DiscordOwnerCredentials {
  readonly token: string;
}

/**
 * The Owner-identity arm (#1569 lane 6): the account's gateway listener
 * under the declared intake posture, delivery and typing as the Owner's
 * account through the package's REST client, mounted as `discord:owner`
 * (a delivery route only when the declaration grants outbound).
 */
function createDiscordOwnerArm(sdk: DiscordOwnerSdk = discordOwnerSdk()): OwnerArm<DiscordOwnerCredentials> {
  return {
    // A bot token carries the `Bot` scheme at the wire; an account token never does.
    credentials: z.object({ token: z.string().min(1).refine((token) => !token.startsWith("Bot ")) }).strict(),
    preconditions: [
      "Owner session from the Discord remote-auth (QR) login, sealed into the vault (the login helper lands with its own lane): the account token",
      "the Owner accepts automation under their own account (declared outbound grant and intake posture)",
    ],
    capabilities: { deliver: true, react: true, media: DISCORD_MEDIA_LIMITS, typing: true },
    listen: true,
    create(credentials, posture, publish, options) {
      const surface = new DiscordOwnerAdapter(credentials, posture, publish, options, sdk);
      return {
        surface,
        account: () => surface.accountIdentity(),
        deliveryRoute: (externalId, payload, idempotencyKey, conversation) =>
          surface.deliver(externalId, payload, idempotencyKey, conversation).then(kernelDeliveryReceipt),
        typingRoute: {
          everyMs: 8_000,
          open: (externalId, conversation) => surface.openTyping(externalId, conversation),
          pulse: (conversation) => surface.typing(conversation),
        },
      };
    },
  };
}

/**
 * Discord: one bot token over the agent-messenger gateway listener (#1569),
 * REST over the package's own client, DM delivery by user id. Operator
 * precondition the credential cannot carry: the MESSAGE CONTENT gateway
 * intent must be enabled in the developer portal, or every inbound `content`
 * arrives empty with no error.
 *
 * The SDK seam is a parameter so tests build the same provider over scripted
 * fakes; production takes the default.
 */
export function createDiscordProvider(
  sdk: DiscordSdk = discordSdk(),
  ownerSdk: DiscordOwnerSdk = discordOwnerSdk(),
): ChannelProvider<DiscordCredentials, "discord", DiscordOwnerCredentials> {
  return {
    id: "discord",
    ingest: "socket",
    owner: createDiscordOwnerArm(ownerSdk),
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
      const surface = new DiscordAdapter(credentials.token, config, publish, options, sdk);
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
}

export const DiscordProvider: ChannelProvider<DiscordCredentials, "discord", DiscordOwnerCredentials> =
  createDiscordProvider();
