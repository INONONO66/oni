import type { Gateway, Outbound } from "@oni/protocol";
import { DeliveryNotSent, DiscordApiError, RateLimited } from "../../errors";
import { type DeliveryReceipt, type DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
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
  classify: (error: Error) => DiscordFailure,
  externalId: string,
): Promise<string> {
  try {
    const channel = await discordCall(
      classify,
      "discord.createDmChannel",
      "createDm" in client ? () => client.createDm(externalId) : () => client.createDM(externalId),
    );
    if (typeof channel?.id !== "string" || channel.id.length === 0)
      throw new DiscordApiError({ message: "Discord DM channel response carried no string id" });
    return channel.id;
  } catch (error) {
    throw new DeliveryNotSent({ operation: "discord.createDmChannel", cause: String(error) });
  }
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
    async (_traceId) => {
      await delivery.ready;
      const channelId =
        conversation?.channelId ?? (await discordDmChannel(client, delivery.classify, externalId));
      return await translate(
        payload,
        DISCORD_RENDER,
        {
          text: async (chunk) => {
            const message = await discordCall(delivery.classify, "discord.createMessage", () =>
              client.createMessage(channelId, {
                content: chunk,
                ...(conversation?.replyToMessageId === undefined
                  ? {}
                  : { reply_to: conversation.replyToMessageId }),
              }),
            );
            return message.id;
          },
          media: {
            limits: DISCORD_MEDIA_LIMITS,
            upload: async (_kind, bytes, caption) => {
              const message = await discordCall(delivery.classify, "discord.createMessage", () =>
                client.createMessage(channelId, {
                  ...(caption === undefined ? {} : { content: caption }),
                  files: [{ data: bytes.bytes, filename: bytes.name, contentType: bytes.mime }],
                  ...(conversation?.replyToMessageId === undefined
                    ? {}
                    : { reply_to: conversation.replyToMessageId }),
                }),
              );
              const externalMessageId = message.id;
              return externalMessageId === undefined ? {} : { externalMessageId };
            },
          },
          react: async (messageId, emoji, replaces) => {
            if (replaces !== undefined)
              await discordCall(
                delivery.classify,
                "discord.removeReaction",
                () => removeSettledReaction(() => client.removeReaction(channelId, messageId, replaces)),
              );
            await discordCall(delivery.classify, "discord.addReaction", () =>
              client.addReaction(channelId, messageId, emoji),
            );
          },
        },
        delivery.options.media,
      );
    },
    (error) => delivery.classify(error) === "rejected" ||
      (error instanceof DiscordApiError && error.rejected === true) ||
      (error instanceof RateLimited && error.status === 429),
    delivery.publish,
    delivery.options,
  );
}

async function discordCall<T>(
  classify: (error: Error) => DiscordFailure,
  operation: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const failure = classify(error);
    if (failure === "not_connected") throw new DeliveryNotSent({ operation, cause: String(error) });
    throw new DiscordApiError({
      message: String(error),
      rejected: failure === "rejected",
    });
  }
}

async function removeSettledReaction(remove: () => Promise<void>): Promise<void> {
  try {
    await remove();
  } catch (error) {
    if (!(error instanceof Error && "httpStatus" in error && error.httpStatus === 404)) throw error;
  }
}
