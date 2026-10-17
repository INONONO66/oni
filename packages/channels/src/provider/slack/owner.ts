import { type Channel, type Gateway, Operational, type Outbound, type PlainValue } from "@openomni/protocol";
import { DeliveryNotSent, SlackEndpointKeyError } from "../../errors";
import { Dedupe } from "../../support/dedupe";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { requireHandler } from "../../support/handler-frame";
import { handoffInbound } from "../../support/inbound-handoff";
import { type ListenerCustody, listenerCustody } from "../../support/sdk-listener";
import { newTraceId } from "../../support/trace";
import { translate } from "../../support/translate";
import type { PublishPort } from "../../types";
import type { AccountIdentity, OwnerPosture, ProviderOptions } from "../contract";
import { slackEmojiName } from "./emoji";
import { SLACK_RENDER } from "./format";
import { SlackNormalizer } from "./normalizer";
import {
  type SlackOwnerApi,
  type SlackOwnerEventMap,
  type SlackOwnerEvents,
  type SlackOwnerSdk,
  slackOwnerSdk,
} from "./owner-sdk";
import { classifySlackFailure, isSettledState, isSlackTerminal, singleAttempt } from "./sdk";
import { SlackMessageEventSchema } from "./types";

/**
 * Slack as the Owner's own account (#1569 lanes 5 and 6): the `slack:owner`
 * instance, logged in with the vault-opened `{token xoxc, cookie d}` the QR
 * login produced. Delivery posts where an authenticated Owner-origin turn
 * said `as: owner` and the instance's declaration grants outbound. Intake is
 * the account's RTM listener under the declared posture: by default a DM to
 * the Owner or a mention of the Owner reaches the Resident, received by the
 * Owner; the account's own messages never do. Reactions are not intake: the
 * router routes a reaction only as the answer to a request, and nothing
 * the Owner's account receives is one. Custody is the bot surface's: one
 * physical attempt per idempotency key on a pinned inner client,
 * `sent | not_sent | unknown` from the SDK's error shapes.
 */
export class SlackOwnerAdapter implements Channel.Surface {
  readonly id = "slack:owner";

  private readonly client: SlackOwnerApi;
  private readonly sdk: SlackOwnerSdk;
  private readonly outbound = new DeliveryReconciliation();
  private readonly dedupe: Dedupe;
  private handler: Channel.MessageHandler | null = null;
  private custody: ListenerCustody | null = null;
  private normalizer: SlackNormalizer | null = null;

  constructor(
    private readonly credentials: { token: string; cookie: string },
    readonly posture: OwnerPosture,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
    sdk: SlackOwnerSdk = slackOwnerSdk(),
  ) {
    this.sdk = sdk;
    this.client = sdk.client();
    this.dedupe = new Dedupe(options.now);
  }

  /** The surface contract's config: an Owner instance carries its posture instead. */
  readonly config: Channel.Config = {};

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  /** The workspace the authenticated session belongs to; every endpoint this instance delivers to must name it. */
  private team: string | null = null;
  private userId: string | null = null;

  /**
   * The account identity is verified before the instance counts as mounted;
   * a refused login fails this start. Under an intake posture the RTM
   * listener then opens, settling on the SDK's first `connected` (hello) and
   * failing this start on an error before it.
   */
  async start(traceId: string): Promise<void> {
    await this.client.login(this.credentials);
    singleAttempt(this.client);
    const identity = await this.client.testAuth();
    this.team = identity.team_id;
    this.userId = identity.user_id;
    this.normalizer = new SlackNormalizer({ botUserId: identity.user_id, team: identity.team_id });
    const listens = this.posture.intake !== "none" && this.handler !== null;
    if (listens) await this.listen();
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "slack owner instance started",
      context: {
        userId: identity.user_id,
        team: identity.team_id,
        listener: listens ? this.posture.intake : "none",
      },
    });
  }

  /** The account's Slack identity (#1600), the shape a Slack endpoint takes: `TEAM:USER` in workspace `TEAM`. */
  account(): AccountIdentity | undefined {
    if (this.team === null || this.userId === null) return undefined;
    return { externalId: `${this.team}:${this.userId}`, workspace: this.team };
  }

  private async listen(): Promise<void> {
    const listener = this.sdk.listener(this.client);
    const custody = listenerCustody<SlackOwnerEventMap>(listener, {
      label: "slack rtm",
      publish: this.publish,
      now: this.options.now,
      id: this.options.id,
      // The SDK's start() resolves before hello and reopens on its own; a
      // close before the first hello is this start's failure to report.
      failOnCloseBeforeConnected: true,
      terminal: isSlackTerminal,
    });
    this.wire(listener);
    this.custody = custody;
    try {
      await custody.start();
    } catch (error) {
      // Custody stopped the SDK's reconnect timer; a failed start owns nothing.
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
      msg: "slack owner instance stopped",
    });
  }

  /** Binds the consumed RTM frames; hello, errors and closes are the custody wrapper's. */
  private wire(listener: SlackOwnerEvents): void {
    listener.on("message", (frame) => {
      // RTM frames carry no `channel_type`; a direct channel is a `D…` id.
      const event = SlackMessageEventSchema.safeParse({
        ...frame,
        ...(frame.channel.startsWith("D") ? { channel_type: "im" } : {}),
      });
      if (event.success) this.handleFrame(event.data, `${frame.channel}:${frame.ts}`);
    });
  }

  /**
   * One frame under the posture: the normalizer keeps the account's own
   * messages out and names a mention of the Owner; `mentions_and_dms` then
   * admits a DM or that mention. A top-level mention of the Owner opens no
   * thread root of its own: the bot's copy of the same message carries
   * none, and one physical message binds to one conversation whichever
   * instance observed it.
   */
  private handleFrame(event: PlainValue, key: string): void {
    const normalizer = this.normalizer;
    if (normalizer === null) return;
    const traceId = newTraceId(this.options.id);
    void handoffInbound({
      dedupe: this.dedupe,
      key,
      traceId,
      now: this.options.now,
      publish: this.publish,
      errorMessage: "slack owner message handling failed",
      rethrowFailure: false,
      handle: async () => {
        const frame = SlackMessageEventSchema.parse(event);
        const inbound = normalizer.normalize(frame);
        if (inbound === null || !this.admits(inbound)) return;
        const { reply, ...facts } = inbound.facts;
        await requireHandler(this.handler, "slack:owner")({
          ...inbound,
          facts: {
            ...facts,
            ...(frame.thread_ts === undefined || reply === undefined ? {} : { reply }),
            receivedBy: "owner",
          },
        });
      },
    });
  }

  private admits(inbound: Channel.InboundMessage): boolean {
    if (this.posture.intake === "all") return true;
    return inbound.facts.dm || inbound.facts.event === "mention";
  }

  /**
   * Delivery as the Owner: the registered ActorEndpoint externalId is the
   * workspace-mandatory `TEAM:USER` pair; without a conversation the Owner's
   * direct channel with that user is opened first. Media parts stay as their
   * reference lines (no upload through the account); reactions are the
   * Owner's own.
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
    // The account session is one workspace's; an endpoint elsewhere is not a
    // send the Owner's account can make, and nothing is attempted.
    if (this.team === null)
      throw new DeliveryNotSent({ operation: "slack.owner", cause: "instance not started" });
    if (team !== this.team)
      throw new DeliveryNotSent({
        operation: "slack.owner",
        cause: `endpoint workspace ${team} is not the account's workspace ${this.team}`,
      });
    const threadTs = conversation?.threadId ?? conversation?.replyToMessageId;
    return deliverKeyed(
      this.outbound,
      idempotencyKey,
      async () => {
        const channelId =
          conversation?.channelId ??
          (await this.client.openConversation(user).then(
            (opened) => opened.channel_id,
            (error) => {
              throw new DeliveryNotSent({ operation: "slack.openConversation", cause: String(error) });
            },
          ));
        return await translate(
          payload,
          SLACK_RENDER,
          {
            text: async (chunk) =>
              (await this.call(() => this.client.sendMessage(channelId, chunk, threadTs)))?.ts,
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

  /** One SDK call under custody's evidence rule (the bot surface's `call`, over the Owner seam's error shape). */
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
}
