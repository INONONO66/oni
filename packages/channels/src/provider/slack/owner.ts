import { type Channel, type Gateway, Operational, type Outbound } from "@openomni/protocol";
import { DeliveryNotSent, SlackEndpointKeyError } from "../../errors";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { translate } from "../../support/translate";
import type { PublishPort } from "../../types";
import type { ProviderOptions } from "../contract";
import { slackEmojiName } from "./emoji";
import { SLACK_RENDER } from "./format";
import { type SlackOwnerApi, type SlackOwnerSdk, slackOwnerSdk } from "./owner-sdk";
import { classifySlackFailure, isSettledState, singleAttempt } from "./sdk";

/**
 * Slack as the Owner's own account (#1569 lane 5): the `slack:owner`
 * instance, logged in with the vault-opened `{token xoxc, cookie d}` the QR
 * login produced. This lane mounts delivery only — the Owner's account posts
 * where an authenticated Owner-origin turn said `as: owner` and the
 * instance's declaration grants outbound; the RTM listener (Owner mentions
 * and DMs reaching the Resident) is lane 6. Custody is the bot surface's:
 * one physical attempt per idempotency key on a pinned inner client,
 * `sent | not_sent | unknown` from the SDK's error shapes.
 */
export class SlackOwnerAdapter implements Channel.Surface {
  readonly id = "slack:owner";

  private readonly client: SlackOwnerApi;
  private readonly outbound = new DeliveryReconciliation();
  private handler: Channel.MessageHandler | null = null;

  constructor(
    private readonly credentials: { token: string; cookie: string },
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
    sdk: SlackOwnerSdk = slackOwnerSdk(),
  ) {
    this.client = sdk.client();
  }

  /** Bound for lane 6's listener; this lane never invokes it. */
  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  /** The workspace the authenticated session belongs to; every endpoint this instance delivers to must name it. */
  private team: string | null = null;

  /** The account identity is verified before the instance counts as mounted; a refused login fails this start. */
  async start(traceId: string): Promise<void> {
    await this.client.login(this.credentials);
    singleAttempt(this.client);
    const identity = await this.client.testAuth();
    this.team = identity.team_id;
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "slack owner instance started",
      context: { userId: identity.user_id, team: identity.team_id, listener: this.handler === null ? "none" : "bound" },
    });
  }

  stop(traceId: string): void {
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "slack owner instance stopped",
    });
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
