import type { Gateway, Outbound } from "@oni/protocol";
import { z } from "zod";
import { DeliveryNotSent, DiscordApiError } from "../../errors";
import { type DeliveryReceipt, type DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { ThrownError } from "../../support/thrown";
import { translate } from "../../support/translate";
import type { PublishPort } from "../../types";
import type { ProviderOptions } from "../contract";
import type { DiscordBotApi, DiscordFailure } from "./sdk";
import type { DiscordOwnerApi } from "./owner-sdk";
import { DISCORD_MEDIA_LIMITS, DISCORD_RENDER } from "./format";

type DiscordClient = DiscordBotApi | DiscordOwnerApi;

/** What one Discord instance delivers with: its REST client under its own token and its custody ledger. */
export interface DiscordDelivery {
  readonly client: DiscordClient;
  readonly ready: Promise<void>;
  readonly classify: (error: Error) => DiscordFailure;
  readonly outbound: DeliveryReconciliation;
  readonly publish: PublishPort;
  readonly options: ProviderOptions;
}

/** A DM channel is created once per delivery (and once per typing turn), never per pulse. */
export async function discordDmChannel(
  client: DiscordClient,
  externalId: string,
): Promise<string> {
  try {
    const channel = await ("createDm" in client ? client.createDm(externalId) : client.createDM(externalId));
    if (typeof channel?.id !== "string" || channel.id.length === 0)
      throw new DiscordApiError({ message: "Discord DM channel response carried no string id" });
    return channel.id;
  } catch (error) {
    throw new DeliveryNotSent({ operation: "discord.createDmChannel", cause: ThrownError.parse(error).message });
  }
}

/**
 * Existing-agent delivery, the same for the bot and the Owner's account
 * (#1569): a registered ActorEndpoint's externalId is a Discord user id —
 * deliver by DM, or into the conversation's channel when the person wrote
 * in one — and report the platform message id of the final chunk (the
 * message a reply would reference). One physical attempt per idempotency
 * key; a platform refusal is proven `not_sent`.
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
    async (_traceId) => {
      await delivery.ready;
      const channelId =
        conversation?.channelId ?? (await discordDmChannel(client, externalId));
      return await translate(
        payload,
        DISCORD_RENDER,
        {
          text: async (chunk) => {
            const message = await client.createMessage(channelId, {
                content: chunk,
                ...(conversation?.replyToMessageId === undefined
                  ? {}
                  : { reply_to: conversation.replyToMessageId }),
              });
            return message.id;
          },
          media: {
            limits: DISCORD_MEDIA_LIMITS,
            upload: async (_kind, bytes, caption) => {
              const message = await client.createMessage(channelId, {
                  ...(caption === undefined ? {} : { content: caption }),
                  files: [{ data: bytes.bytes, filename: bytes.name, contentType: bytes.mime }],
                  ...(conversation?.replyToMessageId === undefined
                    ? {}
                    : { reply_to: conversation.replyToMessageId }),
                });
              return { externalMessageId: message.id };
            },
          },
          react: async (messageId, emoji, replaces) => {
            if (replaces !== undefined)
              await removeSettledReaction(() => client.removeReaction(channelId, messageId, replaces));
            await client.addReaction(channelId, messageId, emoji);
          },
        },
        delivery.options.media,
      );
    },
    (error) => {
      const failure = delivery.classify(error);
      return failure === "rejected" || failure === "not_connected";
    },
    delivery.publish,
    delivery.options,
  );
}

async function removeSettledReaction(remove: () => Promise<void>): Promise<void> {
  await Promise.resolve().then(remove).catch((error: Error) => {
    if (!z.object({ httpStatus: z.literal(404) }).safeParse(error).success) throw error;
  });
}
