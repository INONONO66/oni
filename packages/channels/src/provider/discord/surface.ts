import { newTraceId } from "../../support/trace";
import { type Channel, type Gateway, Operational, type Outbound } from "@openomni/protocol";
import type { z } from "zod";
import { Dedupe } from "../../support/dedupe";
import { handoffInbound } from "../../support/inbound-handoff";
import { requireHandler } from "../../support/handler-frame";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { type ListenerCustody, listenerCustody } from "../../support/sdk-listener";
import { DiscordClient } from "./client";
import {
  DeliveryNotSent,
  DiscordApiError,
  DiscordHandlerMissingError,
  RateLimited,
} from "../../errors";
import { DiscordNormalizer } from "./normalizer";
import {
  DISCORD_INTENTS,
  type DiscordBotApi,
  type DiscordBotEventMap,
  type DiscordSdk,
  discordSdk,
} from "./sdk";
import {
  type DiscordMessage,
  type DiscordReaction,
  type DiscordInteraction,
  DiscordInteractionSchema,
  DiscordMessageSchema,
  DiscordReactionSchema,
} from "./types";
import type { PublishPort } from "../../types";
import type { ProviderOptions } from "../contract";
import { translate } from "../../support/translate";
import { DISCORD_MEDIA_LIMITS, DISCORD_RENDER } from "./format";

/**
 * Discord over the agent-messenger bot SDK's gateway listener (#1569): the
 * SDK owns identify/resume, heartbeats and reconnects; this surface owns the
 * bot identity (from READY), facts-only normalization, inbound dedupe,
 * interaction acks, delivery custody and rendering. REST stays on the
 * package's own client over `fetch-retry` (one physical attempt per key).
 */
export class DiscordAdapter implements Channel.Surface {
  readonly id = "discord:bot";
  private readonly client: DiscordClient;
  private readonly bot: DiscordBotApi;
  private readonly dedupe: Dedupe;
  private readonly outbound = new DeliveryReconciliation();
  private custody: ListenerCustody | null = null;
  private normalizer: DiscordNormalizer | null = null;
  private handler: Channel.MessageHandler | null = null;

  constructor(
    private readonly token: string,
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
    private readonly sdk: DiscordSdk = discordSdk(),
  ) {
    this.dedupe = new Dedupe(options.now);
    this.client = new DiscordClient(token, publish, options.run);
    this.bot = sdk.client();
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  /** Settles on READY; an error or close before it fails this start and leaves no listener. */
  async start(_traceId: string): Promise<void> {
    if (!this.handler) {
      throw new DiscordHandlerMissingError({
        message: "[discord] No message handler registered. Call onMessage() before start().",
      });
    }
    await this.bot.login({ token: this.token });
    const listener = this.sdk.listener(this.bot, { intents: DISCORD_INTENTS });
    const custody = listenerCustody<DiscordBotEventMap>(listener, {
      label: "discord gateway",
      publish: this.publish,
      now: this.options.now,
      id: this.options.id,
      // The SDK's own start() stays pending across a recoverable pre-READY close
      // and rejects on its connect timeout, so a close before READY is its call.
      failOnCloseBeforeConnected: false,
      // The SDK stops itself on 4004/4010-4014 and reports only this error.
      terminal: (error) => /non-recoverable code/.test(error.message),
      // READY (initial connect AND every re-identify) binds the bot identity
      // the normalizer filters and keys on — deliberately its own trace.
      onConnected: ({ user }) => {
        this.normalizer = new DiscordNormalizer(user.id);
        this.publish(Operational.Events.Info, {
          traceId: newTraceId(this.options.id),
          time: this.options.now(),
          component: "server",
          msg: "discord bot started",
          context: { username: user.username, botId: user.id },
        });
      },
    });
    listener.on("message_create", (event) => {
      this.dispatch(
        "MESSAGE_CREATE",
        DiscordMessageSchema.safeParse(event),
        newTraceId(this.options.id),
      );
    });
    listener.on("message_reaction_add", (event) => {
      this.dispatch(
        "MESSAGE_REACTION_ADD",
        DiscordReactionSchema.safeParse(event),
        newTraceId(this.options.id),
      );
    });
    listener.on("interaction_create", (event) => {
      // Only component taps carry a custom_id; slash commands and the rest are not consumed.
      if (event.data === undefined || typeof event.data.custom_id !== "string") return;
      const traceId = newTraceId(this.options.id);
      const interaction = DiscordInteractionSchema.safeParse(event);
      if (!interaction.success) {
        this.warn(traceId, "discord INTERACTION_CREATE payload malformed; dropped");
        return;
      }
      // Defer the interaction before any potentially slow inbound handoff;
      // a refused ack drops the tap rather than answering a dead token later.
      void this.client
        .ackInteraction(interaction.data.id, interaction.data.token, traceId)
        .then(() => this.handleMessageCreate(interaction.data, traceId))
        .catch((error) => {
          this.warn(traceId, "discord interaction acknowledgment failed; dropped", {
            err: String(error),
          });
        });
    });
    this.custody = custody;
    try {
      await custody.start();
    } catch (error) {
      this.custody = null;
      throw error;
    }
  }

  stop(traceId: string): void {
    this.custody?.stop();
    this.custody = null;
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "discord bot stopped",
    });
  }

  private dispatch<T extends DiscordMessage | DiscordReaction>(
    event: "MESSAGE_CREATE" | "MESSAGE_REACTION_ADD",
    parsed: z.ZodSafeParseResult<T>,
    traceId: string,
  ): void {
    if (!parsed.success) {
      this.warn(traceId, `discord ${event} payload malformed; dropped`);
      return;
    }
    this.handleMessageCreate(parsed.data, traceId);
  }

  private warn(traceId: string, msg: string, context?: Record<string, string>): void {
    this.publish(Operational.Events.Warn, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg,
      ...(context === undefined ? {} : { context }),
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
            react: async (messageId, emoji, replaces) => {
              if (replaces !== undefined)
                await this.client.removeReaction(channelId, messageId, replaces, traceId);
              await this.client.react(channelId, messageId, emoji, traceId);
            },
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
  async openTyping(
    externalId: string,
    conversation?: Gateway.Conversation,
  ): Promise<Gateway.Conversation> {
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

  private handleMessageCreate(
    message: DiscordMessage | DiscordReaction | DiscordInteraction,
    traceId: string,
  ): void {
    const normalizer = this.normalizer;
    if (!normalizer) return;
    void handoffInbound({
      dedupe: this.dedupe,
      key:
        "token" in message
          ? message.id
          : "message_id" in message
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
