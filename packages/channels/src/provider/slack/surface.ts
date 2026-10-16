import { type Channel, type Gateway, Operational, type Outbound } from "@openomni/protocol";
import { Dedupe } from "../../support/dedupe";
import { requireHandler } from "../../support/handler-frame";
import { handoffInbound } from "../../support/inbound-handoff";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { type ListenerCustody, listenerCustody } from "../../support/sdk-listener";
import { newTraceId } from "../../support/trace";
import { translate } from "../../support/translate";
import { SLACK_MEDIA_LIMITS, SLACK_RENDER } from "./format";
import { slackEmojiName } from "./emoji";
import type { PublishPort } from "../../types";
import type { ProviderOptions } from "../contract";
import {
  classifySlackFailure,
  isSettledState,
  isSlackTerminal,
  singleAttempt,
  type SlackBotApi,
  type SlackBotEvents,
  type SlackEventArgs,
  type SlackEventsApiArgs,
  type SlackSdk,
  slackSdk,
} from "./sdk";
import { DeliveryNotSent, SlackEndpointKeyError, SlackHandlerMissingError } from "../../errors";
import { SlackNormalizer } from "./normalizer";
import {
  type SlackInteraction,
  SlackInteractionSchema,
  type SlackMessageEvent,
  SlackMessageEventSchema,
} from "./types";

/** How much of a thread a new thread session is seeded with. */
const THREAD_HISTORY_LIMIT = 20;

/**
 * Slack over the agent-messenger bot SDK (#1569): the SDK owns Socket Mode
 * (fresh-URL reconnects, pings, acks) and the Web API; this surface owns the
 * bot identity, facts-only normalization, inbound dedupe, delivery custody
 * and rendering. Every Socket Mode envelope is acked before anything else
 * happens to it — Slack redelivers unacked envelopes forever and a handler
 * failure must not become a redelivery loop; inbound dedupe covers the
 * at-least-once remainder.
 */
export class SlackAdapter implements Channel.Surface {
  readonly id = "slack";

  private readonly client: SlackBotApi;
  private readonly dedupe: Dedupe;
  private readonly outbound = new DeliveryReconciliation();
  private custody: ListenerCustody | null = null;
  private normalizer: SlackNormalizer | null = null;
  private botUserId: string | null = null;
  private handler: Channel.MessageHandler | null = null;

  constructor(
    private readonly credentials: { botToken: string; appToken: string },
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
    private readonly sdk: SlackSdk = slackSdk(),
  ) {
    this.dedupe = new Dedupe(options.now);
    this.client = sdk.client();
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Identity before the socket: mention detection, self-filtering and
   * workspace-scoped keys need the bot user id and team id. Start settles on
   * the SDK's first `connected` (Slack's hello) and fails on an error before
   * it — the caller owns boot retry, and a rejected start leaves no listener.
   */
  async start(traceId: string): Promise<void> {
    if (!this.handler) {
      throw new SlackHandlerMissingError({
        message: "[slack] No message handler registered. Call onMessage() before start().",
      });
    }
    await this.client.login({ token: this.credentials.botToken });
    singleAttempt(this.client);
    const identity = await this.client.testAuth();
    this.botUserId = identity.user_id;
    this.normalizer = new SlackNormalizer({ botUserId: identity.user_id, team: identity.team_id });
    const listener = this.sdk.listener(this.client, { appToken: this.credentials.appToken });
    const custody = listenerCustody(listener, {
      label: "slack socket",
      publish: this.publish,
      now: this.options.now,
      id: this.options.id,
      terminal: isSlackTerminal,
    });
    this.wire(listener);
    this.custody = custody;
    try {
      await custody.start();
    } catch (error) {
      this.custody = null;
      throw error;
    }
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "slack bot started",
      context: { botUserId: identity.user_id, team: identity.team_id },
    });
  }

  stop(traceId: string): void {
    this.custody?.stop();
    this.custody = null;
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "slack bot stopped",
    });
  }

  /** Binds the consumed Socket Mode events; hello, errors and closes are the custody wrapper's. */
  private wire(listener: SlackBotEvents): void {
    // Every Events API envelope arrives here (after its typed event); the
    // ack goes out first, then the two consumed event types are handed off.
    listener.on("slack_event", (args) => {
      if (!isEventsApi(args)) return;
      args.ack();
      const event = SlackMessageEventSchema.safeParse(args.event);
      if (!event.success) return;
      if (event.data.type !== "message" && event.data.type !== "reaction_added") return;
      this.handleMessageEvent(event.data, newTraceId(this.options.id));
    });
    listener.on("interactive", (args) => {
      args.ack();
      const interaction = SlackInteractionSchema.safeParse(args.body);
      if (interaction.success) {
        this.handleMessageEvent(interaction.data, newTraceId(this.options.id));
        return;
      }
      this.publish(Operational.Events.Warn, {
        traceId: newTraceId(this.options.id),
        time: this.options.now(),
        component: "server",
        msg: "slack interactive payload not a block action; dropped",
      });
    });
    listener.on("slash_commands", (args) => {
      args.ack();
    });
  }

  /**
   * Existing-agent delivery. The registered ActorEndpoint externalId is the
   * workspace-mandatory `TEAM:USER` pair (docs/provisioning-and-providers.md)
   * — a bare user id is refused, never guessed at. Without a conversation the
   * bot's direct channel is opened first: uploads and reactions take a channel
   * id and refuse a bare user id, and a failed open is a proven `not_sent`.
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
    const thread = threadTs === undefined ? {} : { thread_ts: threadTs };
    return deliverKeyed(
      this.outbound,
      idempotencyKey,
      async () => {
        const channelId =
          conversation?.channelId ??
          (await this.client.openDm(user).catch((error) => {
            throw new DeliveryNotSent({ operation: "slack.openDm", cause: String(error) });
          }));
        return await translate(
          payload,
          SLACK_RENDER,
          {
            text: async (chunk) =>
              (await this.call(() => this.client.postMessage(channelId, chunk, thread)))?.ts,
            media: {
              limits: SLACK_MEDIA_LIMITS,
              // The upload's share message carries no ts: an acknowledgement without an id.
              upload: async (_kind, bytes, caption) => {
                await this.call(() =>
                  this.client.uploadFile(channelId, Buffer.from(bytes.bytes), bytes.name, {
                    ...thread,
                    ...(caption === undefined ? {} : { initial_comment: caption }),
                  }),
                );
                return {};
              },
            },
            react: async (messageId, emoji, replaces) => {
              const name = slackEmojiName(emoji);
              const replaced = replaces === undefined ? undefined : slackEmojiName(replaces);
              if (name === undefined || (replaces !== undefined && replaced === undefined))
                throw new DeliveryNotSent({
                  operation: "slack.react",
                  cause: `no slack name for ${name === undefined ? emoji : replaces}`,
                });
              if (replaced !== undefined)
                await this.call(
                  () => this.client.removeReaction(channelId, messageId, replaced),
                  ["no_reaction"],
                );
              await this.call(
                () => this.client.addReaction(channelId, messageId, name),
                ["already_reacted"],
              );
            },
          },
          this.options.media,
        );
      },
      (error) => classifySlackFailure(error) === "rejected",
      this.publish,
      this.options,
    );
  }

  /**
   * One SDK call under custody's evidence rule: a state that already holds
   * is success, a never-established connection is `DeliveryNotSent`, and
   * every other failure propagates for `classifySlackFailure` to judge.
   */
  private async call<T>(
    operation: () => Promise<T>,
    settled: readonly string[] = [],
  ): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (isSettledState(error, settled)) return undefined;
      if (classifySlackFailure(error) === "not_connected")
        throw new DeliveryNotSent({ operation: "slack.api", cause: String(error) });
      throw error;
    }
  }

  private handleMessageEvent(event: SlackMessageEvent | SlackInteraction, traceId: string): void {
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
            "actions" in event
              ? inbound
              : await this.withThreadHistory(inbound, event, botUserId, traceId),
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
      const earlier = (
        await this.client.getThreadReplies(event.channel, threadTs, {
          limit: THREAD_HISTORY_LIMIT + 1,
        })
      )
        .filter((message) => message.text && Number(message.ts) < Number(event.ts))
        .slice(-THREAD_HISTORY_LIMIT)
        .map((message) => ({
          author:
            message.user === botUserId
              ? "assistant"
              : message.user !== undefined
                ? `<@${message.user}>`
                : message.username !== undefined
                  ? `bot ${message.username}`
                  : "someone",
          text: message.text,
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

/** The SDK's `slack_event` carries Events API args (with an ack) or a bare envelope the SDK did not type. */
function isEventsApi(args: SlackEventArgs): args is SlackEventsApiArgs {
  return typeof args.ack === "function";
}
