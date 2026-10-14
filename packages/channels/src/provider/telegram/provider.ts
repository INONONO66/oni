import { kernelDeliveryReceipt } from "../../support/deliver.js";
import { z } from "zod";
import type { ChannelProvider } from "../contract.js";
import { TELEGRAM_MEDIA_LIMITS, TELEGRAM_RENDER } from "./format.js";
import { TelegramAdapter } from "./surface.js";

interface TelegramCredentials {
  /** BotFather bot token. */
  readonly token: string;
}

/** Telegram: one BotFather token, ordered long-poll ingress, DM delivery by chat id. */
export const TelegramProvider: ChannelProvider<TelegramCredentials, "telegram"> = {
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
    const surface = new TelegramAdapter(credentials.token, config, publish, options);
    return {
      surface,
      deliveryRoute: (externalId, payload, idempotencyKey, conversation) =>
        surface
          .deliver(externalId, payload, idempotencyKey, conversation)
          .then(kernelDeliveryReceipt),
      typingRoute: (externalId, conversation) => surface.typing(externalId, conversation),
    };
  },
};
