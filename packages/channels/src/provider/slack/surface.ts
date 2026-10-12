import { type Channel, Operational } from "@openomni/protocol";
import { Dedupe } from "../../support/dedupe";
import { requireHandler } from "../../support/handler-frame";
import { handoffInbound } from "../../support/inbound-handoff";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { sendText } from "../../support/send-text";
import { SLACK_RENDER } from "./format";
import type { EffectRunner, PublishPort } from "../../types";
import { SlackClient } from "./client";
import {
  DeliveryNotSent,
  SlackApiError,
  SlackEndpointKeyError,
  SlackHandlerMissingError,
  RateLimited,
} from "../../errors";
import { SlackNormalizer } from "./normalizer";
import { SlackSocket } from "./socket";
import type { SlackMessageEvent, SocketEnvelope } from "./types";

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
    private readonly options: {
      readonly now: () => number;
      readonly id: () => string;
      readonly random: () => number;
      readonly run: EffectRunner;
    },
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
    body: string,
    idempotencyKey: string,
  ): Promise<DeliveryReceipt> {
    const [team, user] = externalId.split(":");
    if (!(team && user)) {
      throw new SlackEndpointKeyError({
        message: `slack endpoint externalId must be "TEAM:USER", got "${externalId}"`,
      });
    }
    return deliverKeyed(
      this.outbound,
      idempotencyKey,
      async (traceId) => {
        const channelId = await this.client.openDm(user, traceId).catch((error) => {
          throw new DeliveryNotSent({ operation: "slack.openDm", cause: String(error) });
        });
        return await sendText(body, SLACK_RENDER, (chunk) =>
          this.client.send(channelId, chunk, traceId),
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
    const event = envelope.payload?.event;
    if (event === undefined || (event.type !== "message" && event.type !== "reaction_added"))
      return;
    this.handleMessageEvent(event, traceId);
  }

  private handleMessageEvent(event: SlackMessageEvent, traceId: string): void {
    const normalizer = this.normalizer;
    const botUserId = this.botUserId;
    if (!(normalizer && botUserId)) return;
    void handoffInbound({
      dedupe: this.dedupe,
      key:
        event.type === "reaction_added"
          ? `${event.item?.channel}:${event.item?.ts}:${event.reaction}:${event.user}`
          : `${event.channel}:${event.ts}`,
      traceId,
      now: this.options.now,
      publish: this.publish,
      errorMessage: "slack message handling failed",
      rethrowFailure: false,
      handle: async () => {
        const inbound = normalizer.normalize(event);
        if (inbound) await this.handleIncoming(inbound);
      },
    });
  }

  private async handleIncoming(inbound: Channel.InboundMessage): Promise<void> {
    await requireHandler(this.handler, "slack")(inbound);
  }
}
