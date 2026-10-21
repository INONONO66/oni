import type { Gateway, Outbound } from "@oni/protocol";
import { DeliveryNotSent, DiscordApiError, RateLimited } from "../../errors";
import { type DeliveryReceipt, type DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { translate } from "../../support/translate";
import type { PublishPort } from "../../types";
import type { ProviderOptions } from "../contract";
import type { DiscordClient } from "./client";
import { DISCORD_MEDIA_LIMITS, DISCORD_RENDER } from "./format";

/** What one Discord instance delivers with: its REST client under its own token and its custody ledger. */
export interface DiscordDelivery {
  readonly client: DiscordClient;
  readonly outbound: DeliveryReconciliation;
  readonly publish: PublishPort;
  readonly options: ProviderOptions;
}

/** A DM channel is created once per delivery (and once per typing turn), never per pulse. */
export function discordDmChannel(client: DiscordClient, externalId: string, traceId: string): Promise<string> {
  return client.createDmChannel(externalId, traceId).catch((error) => {
    throw new DeliveryNotSent({ operation: "discord.createDmChannel", cause: String(error) });
  });
}

/**
 * Existing-agent delivery, the same for the bot and the Owner's account
 * (#1569): a registered ActorEndpoint's externalId is a Discord user id —
 * deliver by DM, or into the conversation's channel when the person wrote
 * in one — and report the platform message id of the final chunk (the
 * message a reply would reference). One physical attempt per idempotency
 * key; a platform refusal or a typed rate limit is proven `not_sent`.
 */
export function deliverThroughDiscord(
  delivery: DiscordDelivery,
  externalId: string,
  payload: Outbound.Payload,
  idempotencyKey: string,
  conversation?: Gateway.Conversation,
): Promise<DeliveryReceipt> {
  const { client } = delivery;
  return deliverKeyed(
    delivery.outbound,
    idempotencyKey,
    async (traceId) => {
      const channelId = conversation?.channelId ?? (await discordDmChannel(client, externalId, traceId));
      return await translate(
        payload,
        DISCORD_RENDER,
        {
          text: (chunk) => client.send(channelId, chunk, traceId, conversation),
          media: {
            limits: DISCORD_MEDIA_LIMITS,
            upload: async (_kind, bytes, caption) => {
              const externalMessageId = await client.sendMedia(channelId, bytes, caption, traceId, conversation);
              return externalMessageId === undefined ? {} : { externalMessageId };
            },
          },
          react: async (messageId, emoji, replaces) => {
            if (replaces !== undefined) await client.removeReaction(channelId, messageId, replaces, traceId);
            await client.react(channelId, messageId, emoji, traceId);
          },
        },
        delivery.options.media,
      );
    },
    (error) =>
      (error instanceof DiscordApiError && error.rejected === true) ||
      (error instanceof RateLimited && error.status === 429),
    delivery.publish,
    delivery.options,
  );
}
