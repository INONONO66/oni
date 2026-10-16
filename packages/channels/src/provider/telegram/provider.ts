import { kernelDeliveryReceipt } from "../../support/deliver.js";
import { z } from "zod";
import type { ChannelProvider } from "../contract.js";
import { TELEGRAM_MEDIA_LIMITS, TELEGRAM_RENDER } from "./format.js";
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
): ChannelProvider<TelegramCredentials, "telegram"> {
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
    },
    credentials: z.object({ token: z.string().min(1) }).strict(),
    settings: z.record(z.string(), z.never()),
    preconditions: [],
    create(credentials, config, publish, options) {
      const surface = new TelegramAdapter(credentials.token, config, publish, options, sdk);
      return {
        surface,
        deliveryRoute: (externalId, payload, idempotencyKey, conversation) =>
          surface
            .deliver(externalId, payload, idempotencyKey, conversation)
            .then(kernelDeliveryReceipt),
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

export const TelegramProvider: ChannelProvider<TelegramCredentials, "telegram"> =
  createTelegramProvider();
