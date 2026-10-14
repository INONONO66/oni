import { newTraceId } from "../../support/trace";
import { type Channel, type Gateway, Operational, type Outbound } from "@openomni/protocol";
import { Dedupe } from "../../support/dedupe";
import { handoffInbound } from "../../support/inbound-handoff";
import { requireHandler } from "../../support/handler-frame";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { DiscordClient } from "./client";
import {
  DeliveryNotSent,
  DiscordApiError,
  DiscordHandlerMissingError,
  RateLimited,
} from "../../errors";
import { DiscordGateway } from "./gateway";
import { DiscordNormalizer } from "./normalizer";
import {
  type DiscordMessage,
  type DiscordReaction,
  DiscordMessageSchema,
  DiscordReactionSchema,
} from "./types";
import type { PublishPort } from "../../types";
import type { ProviderOptions } from "../contract";
import { translate } from "../../support/translate";
import { DISCORD_MEDIA_LIMITS, DISCORD_RENDER } from "./format";

export class DiscordAdapter implements Channel.Surface {
  readonly id = "discord";
  private readonly client: DiscordClient;
  private readonly gateway: DiscordGateway;
  private readonly dedupe: Dedupe;
  private readonly outbound = new DeliveryReconciliation();
  private normalizer: DiscordNormalizer | null = null;
  private handler: Channel.MessageHandler | null = null;

  constructor(
    token: string,
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
  ) {
    this.dedupe = new Dedupe(options.now);
    this.client = new DiscordClient(token, publish, options.run);
    this.gateway = new DiscordGateway(
      token,
      () => this.client.fetchGatewayUrl(),
      {
        onReady: ({ botId, botUsername }) => {
          this.normalizer = new DiscordNormalizer(botId);
          this.publish(Operational.Events.Info, {
            // Origin: a gateway READY is a distinct occurrence (initial connect
            // AND every re-identify) — deliberately its own trace, not the boot's.
            traceId: newTraceId(this.options.id),
            time: this.options.now(),
            component: "server",
            msg: "discord bot started",
            context: { username: botUsername, botId },
          });
        },
        onDispatch: (event, data, traceId) => {
          if (event !== "MESSAGE_CREATE" && event !== "MESSAGE_REACTION_ADD") return;
          const message =
            event === "MESSAGE_CREATE"
              ? DiscordMessageSchema.safeParse(data)
              : DiscordReactionSchema.safeParse(data);
          if (!message.success) {
            this.publish(Operational.Events.Warn, {
              traceId,
              time: this.options.now(),
              component: "server",
              msg: `discord ${event} payload malformed; dropped`,
            });
            return;
          }
          this.handleMessageCreate(message.data, traceId);
        },
      },
      publish,
      options,
    );
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  async start(_traceId: string): Promise<void> {
    if (!this.handler) {
      throw new DiscordHandlerMissingError({
        message: "[discord] No message handler registered. Call onMessage() before start().",
      });
    }
    await this.gateway.start();
  }

  stop(traceId: string): void {
    this.gateway.stop();
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "discord bot stopped",
    });
  }

  /**
   * Existing-agent delivery: a registered ActorEndpoint's externalId is a
   * Discord user id — deliver by DM, or into the conversation's channel when
   * the person wrote in one — and report the platform message id of the
   * final chunk (the message a reply would reference).
   */
  deliver(
    externalId: string,
    payload: Outbound.Payload,
    idempotencyKey: string,
    conversation?: Gateway.Conversation,
  ): Promise<DeliveryReceipt> {
    return deliverKeyed(
      this.outbound,
      idempotencyKey,
      async (traceId) => {
        const channelId = conversation?.channelId ?? (await this.dmChannel(externalId, traceId));
        return await translate(
          payload,
          DISCORD_RENDER,
          {
            text: (chunk) => this.client.send(channelId, chunk, traceId, conversation),
            media: {
              limits: DISCORD_MEDIA_LIMITS,
              upload: async (_kind, bytes, caption) => {
                const externalMessageId = await this.client.sendMedia(
                  channelId,
                  bytes,
                  caption,
                  traceId,
                  conversation,
                );
                return externalMessageId === undefined ? {} : { externalMessageId };
              },
            },
            react: (messageId, emoji) => this.client.react(channelId, messageId, emoji, traceId),
          },
          this.options.media,
        );
      },
      (error) =>
        (error instanceof DiscordApiError && error.rejected === true) ||
        (error instanceof RateLimited && error.status === 429),
      this.publish,
      this.options,
    );
  }

  /** A DM channel is created once per turn, not once per pulse. */
  async openTyping(externalId: string, conversation?: Gateway.Conversation): Promise<Gateway.Conversation> {
    if (conversation !== undefined) return conversation;
    return { channelId: await this.dmChannel(externalId, newTraceId(this.options.id)) };
  }

  typing(conversation: Gateway.Conversation): Promise<void> {
    return this.client.typing(conversation.channelId, newTraceId(this.options.id));
  }

  private dmChannel(externalId: string, traceId: string): Promise<string> {
    return this.client.createDmChannel(externalId, traceId).catch((error) => {
      throw new DeliveryNotSent({ operation: "discord.createDmChannel", cause: String(error) });
    });
  }

  private handleMessageCreate(message: DiscordMessage | DiscordReaction, traceId: string): void {
    const normalizer = this.normalizer;
    if (!normalizer) return;
    void handoffInbound({
      dedupe: this.dedupe,
      key:
        "message_id" in message
          ? `${message.message_id}:${message.emoji.name}:${message.user_id}`
          : message.id,
      traceId,
      now: this.options.now,
      publish: this.publish,
      errorMessage: "discord message handling failed",
      rethrowFailure: false,
      handle: async () => {
        const inbound = normalizer.normalize(message);
        if (inbound) await this.handleIncoming(inbound, message.channel_id, traceId);
      },
    });
  }

  private async handleIncoming(
    inbound: Channel.InboundMessage,
    channelId: string,
    traceId: string,
  ): Promise<void> {
    this.publish(Operational.Events.Debug, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "discord message received",
      context: { channelId },
    });
    await requireHandler(this.handler, "discord")(inbound);
  }
}
