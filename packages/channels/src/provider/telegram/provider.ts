import { z } from "zod";
import type { ChannelProvider } from "../contract.js";
import { kernelDeliveryRoute } from "../delivery-route.js";
import { TELEGRAM_MEDIA_LIMITS, TELEGRAM_RENDER } from "./format.js";
import { TelegramOwnerCredentials } from "./owner-contract.js";
import { TelegramOwnerAdapter } from "./owner.js";
import { type TelegramOwnerSdk, telegramOwnerSdk } from "./owner-sdk.js";
import { type TelegramSdk, telegramSdk } from "./sdk.js";
import { TelegramAdapter } from "./surface.js";

interface TelegramCredentials {
  /** BotFather bot token. */
  readonly token: string;
}

/**
 * Telegram: one BotFather token, long-poll ingress through the agent-messenger
 * bot listener (#1569), REST over the package's own client, DM delivery by
 * chat id. The SDK seam is a parameter so tests build the same provider over
 * scripted fakes; production takes the default.
 */
export function createTelegramProvider(
  sdk: TelegramSdk = telegramSdk(),
  ownerSdk: TelegramOwnerSdk = telegramOwnerSdk(),
): ChannelProvider<TelegramCredentials, "telegram", TelegramOwnerCredentials> {
  return {
    id: "telegram",
    ingest: "poll",
    capabilities: {
      deliver: true,
      webhook: false,
      render: TELEGRAM_RENDER,
      media: TELEGRAM_MEDIA_LIMITS,
      react: true,
      typing: true,
      voice: false,
    },
    credentials: z.object({ token: z.string().min(1) }).strict(),
    settings: z.record(z.string(), z.never()),
    preconditions: [],
    owner: {
      credentials: TelegramOwnerCredentials,
      preconditions: ["Telegram account API credentials and an exclusive private data directory"],
      listen: true,
      capabilities: {
        deliver: true,
        react: false,
        typing: false,
        voice: false,
        history: true,
        media: TELEGRAM_MEDIA_LIMITS,
      },
      create(credentials, posture, publish, options) {
        const surface = new TelegramOwnerAdapter(credentials, posture, publish, options, ownerSdk);
        return {
          surface,
          account: () => surface.accountIdentity(),
          deliveryRoute: (...args) => surface.deliver(...args),
          historyRoute: (query) => surface.history(query),
          onWithdrawn: (listener) => surface.onWithdrawn(listener),
          streamingAttachments: (ref, bounds) => surface.download(ref, bounds),
        };
      },
    },
    create(credentials, config, publish, options) {
      const surface = new TelegramAdapter(credentials.token, config, publish, options, sdk);
      return {
        surface,
        attachments: (ref, bounds) => surface.download(ref, bounds),
        deliveryRoute: kernelDeliveryRoute(surface),
        // sendChatAction shows "typing" for about five seconds.
        typingRoute: {
          everyMs: 4_000,
          open: (externalId, conversation) => surface.openTyping(externalId, conversation),
          pulse: (conversation) => surface.typing(conversation),
        },
      };
    },
  };
}

export const TelegramProvider: ChannelProvider<TelegramCredentials, "telegram", TelegramOwnerCredentials> =
  createTelegramProvider();
