import { type Channel, type Gateway, Operational, type Outbound } from "@openomni/protocol";
import { Dedupe } from "../../support/dedupe";
import { requireHandler } from "../../support/handler-frame";
import { handoffInbound } from "../../support/inbound-handoff";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { translate } from "../../support/translate";
import { SLACK_MEDIA_LIMITS, SLACK_RENDER } from "./format";
import { slackEmojiName } from "./emoji";
import type { PublishPort } from "../../types";
import type { ProviderOptions } from "../contract";
import { SlackClient, THREAD_HISTORY_LIMIT } from "./client";
import {
  DeliveryNotSent,
  SlackApiError,
  SlackEndpointKeyError,
  SlackHandlerMissingError,
  RateLimited,
} from "../../errors";
import { SlackNormalizer } from "./normalizer";
import { SlackSocket } from "./socket";
import { renderSlack, splitSlackBlocks } from "./render.js";
import {
  SlackInteractionSchema,
  type SlackMessageEvent,
  type SocketEnvelope,
} from "./types";

export class SlackAdapter implements Channel.Surface {
  readonly id = "slack";

  private readonly client: SlackClient;
  private readonly socket: SlackSocket;
  private readonly dedupe: Dedupe;
  private readonly outbound = new DeliveryReconciliation();
  private normalizer: SlackNormalizer | null = null;
  private botUserId: string | null = null;
  private handler: Channel.MessageHandler | null = null;

  constructor(
    credentials: { botToken: string; appToken: string },
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
  ) {
    this.dedupe = new Dedupe(options.now);
    this.client = new SlackClient(credentials.botToken, credentials.appToken, publish, options.run);
    this.socket = new SlackSocket(
      (traceId) => this.client.openSocketUrl(traceId),
      { onEvent: (envelope, traceId) => this.handleEnvelope(envelope, traceId) },
      publish,
      options,
    );
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  async start(traceId: string): Promise<void> {
    if (!this.handler) {
      throw new SlackHandlerMissingError({
        message: "[slack] No message handler registered. Call onMessage() before start().",
      });
    }
    // Identity BEFORE the socket: mention detection, self-filtering, and
    // workspace-scoped keys all need the bot user id and team id.
    const identity = await this.client.authTest(traceId);
    this.botUserId = identity.botUserId;
    this.normalizer = new SlackNormalizer({
      botUserId: identity.botUserId,
      team: identity.team,
    });
    await this.socket.start();
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "slack bot started",
      context: { botUserId: identity.botUserId, team: identity.team },
    });
  }

  stop(traceId: string): void {
    this.socket.stop();
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "slack bot stopped",
    });
  }

  /**
   * Existing-agent delivery. The registered ActorEndpoint externalId is the
   * workspace-mandatory `TEAM:USER` pair (docs/provisioning-and-providers.md)
   * — a bare user id is refused, never guessed at.
   */
  async deliver(
    externalId: string,
    payload: Outbound.Payload,
    idempotencyKey: string,
    conversation?: Gateway.Conversation,
  ): Promise<DeliveryReceipt> {
    const [team, user] = externalId.split(":");
    if (!(team && user)) {
      throw new SlackEndpointKeyError({
        message: `slack endpoint externalId must be "TEAM:USER", got "${externalId}"`,
      });
    }
    // Slack answers a message by threading under it, so a reply-to is a thread root too.
    const threadTs = conversation?.threadId ?? conversation?.replyToMessageId;
    return deliverKeyed(
      this.outbound,
      idempotencyKey,
      async (traceId) => {
        const channelId =
          conversation?.channelId ??
          (await this.client.openDm(user, traceId).catch((error) => {
            throw new DeliveryNotSent({ operation: "slack.openDm", cause: String(error) });
          }));
        return await translate(
          payload,
          SLACK_RENDER,
          {
            text: (chunk) =>
              threadTs === undefined
                ? this.client.send(channelId, chunk, traceId)
                : this.client.sendInThread(channelId, threadTs, chunk, traceId),
            media: {
              limits: SLACK_MEDIA_LIMITS,
              upload: async (_kind, bytes, caption) => {
                await this.client.sendMedia(channelId, threadTs, bytes, caption, traceId);
                return {};
              },
            },
            native: async (step) => {
              let externalMessageId: string | undefined;
              for (const blocks of splitSlackBlocks(renderSlack(step)))
                externalMessageId = await this.client.sendBlocks(channelId, blocks, step.digest, traceId, threadTs);
              return externalMessageId === undefined ? {} : { externalMessageId };
            },
            react: async (messageId, emoji, replaces) => {
              const name = slackEmojiName(emoji);
              const replaced = replaces === undefined ? undefined : slackEmojiName(replaces);
              if (name === undefined || (replaces !== undefined && replaced === undefined))
                throw new DeliveryNotSent({
                  operation: "slack.react",
                  cause: `no slack name for ${name === undefined ? emoji : replaces}`,
                });
              if (replaced !== undefined) await this.client.removeReaction(channelId, messageId, replaced, traceId);
              await this.client.react(channelId, messageId, name, traceId);
            },
          },
          this.options.media,
        );
      },
      (error) =>
        (error instanceof SlackApiError && error.rejected === true) ||
        (error instanceof RateLimited && error.status === 429),
      this.publish,
      this.options,
    );
  }

  private handleEnvelope(envelope: SocketEnvelope, traceId: string): void {
    if (envelope.type === "interactive" && envelope.payload?.type === "block_actions") {
      const interaction = SlackInteractionSchema.safeParse(envelope.payload);
      if (interaction.success) this.handleMessageEvent(interaction.data, traceId);
      else this.publish(Operational.Events.Warn, {
        traceId, time: this.options.now(), component: "server",
        msg: "slack block_actions payload malformed; dropped",
      });
      return;
    }
    const event = envelope.payload?.event;
    if (event === undefined || (event.type !== "message" && event.type !== "reaction_added"))
      return;
    this.handleMessageEvent(event, traceId);
  }

  private handleMessageEvent(event: SlackMessageEvent | import("./types").SlackInteraction, traceId: string): void {
    const normalizer = this.normalizer;
    const botUserId = this.botUserId;
    if (!(normalizer && botUserId)) return;
    void handoffInbound({
      dedupe: this.dedupe,
      key:
        "actions" in event
          ? `${event.channel.id}:${event.actions[0].action_ts}:${event.user.id}`
          : event.type === "reaction_added"
          ? `${event.item?.channel}:${event.item?.ts}:${event.reaction}:${event.user}`
          : `${event.channel}:${event.ts}`,
      traceId,
      now: this.options.now,
      publish: this.publish,
      errorMessage: "slack message handling failed",
      rethrowFailure: false,
      handle: async () => {
        const inbound = normalizer.normalize(event);
        if (inbound)
          await this.handleIncoming(
            "actions" in event ? inbound : await this.withThreadHistory(inbound, event, botUserId, traceId),
          );
      },
    });
  }

  /**
   * An in-thread message carries the thread's earlier messages so a session
   * opened mid-thread starts with what the person can see. The fetch failing
   * (scope, rate limit) costs the context, never the message.
   */
  private async withThreadHistory(
    inbound: Channel.InboundMessage,
    event: SlackMessageEvent,
    botUserId: string,
    traceId: string,
  ): Promise<Channel.InboundMessage> {
    const threadTs = event.type === "reaction_added" ? undefined : event.thread_ts;
    if (threadTs === undefined || event.channel === undefined || threadTs === event.ts)
      return inbound;
    try {
      const earlier = (await this.client.threadReplies(event.channel, threadTs, traceId))
        .filter((message) => message.text && Number(message.ts) < Number(event.ts))
        .slice(-THREAD_HISTORY_LIMIT)
        .map((message) => ({
          author:
            message.user === botUserId
              ? "assistant"
              : message.user !== undefined
                ? `<@${message.user}>`
                : message.bot_id !== undefined
                  ? `bot ${message.bot_id}`
                  : "someone",
          text: message.text ?? "",
        }));
      return earlier.length === 0
        ? inbound
        : {
            ...inbound,
            facts: { ...inbound.facts, context: { ...inbound.facts.context, thread: earlier } },
          };
    } catch (error) {
      this.publish(Operational.Events.Warn, {
        traceId,
        time: this.options.now(),
        component: "server",
        msg: "slack thread history unavailable; message delivered without it",
        context: { err: String(error), channel: event.channel, threadTs },
      });
      return inbound;
    }
  }

  private async handleIncoming(inbound: Channel.InboundMessage): Promise<void> {
    await requireHandler(this.handler, "slack")(inbound);
  }
}
