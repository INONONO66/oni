import { type Channel, type Gateway, Operational, type Outbound } from "@openomni/protocol";
import type { z } from "zod";
import { Dedupe } from "../../support/dedupe";
import { type DeliveryReceipt, DeliveryReconciliation } from "../../support/deliver";
import { requireHandler } from "../../support/handler-frame";
import { handoffInbound } from "../../support/inbound-handoff";
import { type ListenerCustody, listenerCustody } from "../../support/sdk-listener";
import { newTraceId } from "../../support/trace";
import type { PublishPort } from "../../types";
import type { OwnerPosture, ProviderOptions } from "../contract";
import { DiscordClient } from "./client";
import { type DiscordDelivery, deliverThroughDiscord, discordDmChannel } from "./delivery";
import { DiscordNormalizer } from "./normalizer";
import {
  type DiscordOwnerApi,
  type DiscordOwnerEventMap,
  type DiscordOwnerSdk,
  discordOwnerSdk,
} from "./owner-sdk";
import { type DiscordMessage, DiscordMessageSchema } from "./types";

/**
 * Discord as the Owner's own account (#1569 lane 6): the `discord:owner`
 * instance, logged in with the vault-opened account token the remote-auth
 * login produced. Delivery and typing ride the package's REST client under
 * the bare token (one physical attempt per idempotency key); intake is the
 * account's gateway listener under the declared posture: by default a DM to
 * the Owner or a mention of the Owner reaches the Resident, received by
 * the Owner; the account's own messages never do. Reactions are not intake:
 * the router routes a reaction only as the answer to a request, and nothing
 * the Owner's account receives is one.
 */
export class DiscordOwnerAdapter implements Channel.Surface {
  readonly id = "discord:owner";
  /** The surface contract's config: an Owner instance carries its posture instead. */
  readonly config: Channel.Config = {};

  private readonly client: DiscordClient;
  private readonly account: DiscordOwnerApi;
  private readonly sdk: DiscordOwnerSdk;
  private readonly dedupe: Dedupe;
  private readonly outbound = new DeliveryReconciliation();
  private custody: ListenerCustody | null = null;
  private normalizer: DiscordNormalizer | null = null;
  private handler: Channel.MessageHandler | null = null;

  constructor(
    private readonly credentials: { token: string },
    readonly posture: OwnerPosture,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
    sdk: DiscordOwnerSdk = discordOwnerSdk(),
  ) {
    this.sdk = sdk;
    this.client = new DiscordClient(credentials.token, publish, options.run, "user");
    this.account = sdk.client();
    this.dedupe = new Dedupe(options.now);
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  /**
   * The account identity is verified before the instance counts as mounted;
   * a refused login fails this start. Under an intake posture the gateway
   * listener then opens, settling on READY and failing this start on an
   * error before it.
   */
  async start(traceId: string): Promise<void> {
    await this.account.login(this.credentials);
    // The identity check rides the package's client: one attempt, no hidden sleeps.
    const identity = await this.client.me(traceId);
    this.normalizer = new DiscordNormalizer(identity.id);
    const listens = this.posture.intake !== "none" && this.handler !== null;
    if (listens) await this.listen();
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "discord owner instance started",
      context: {
        userId: identity.id,
        username: identity.username,
        listener: listens ? this.posture.intake : "none",
      },
    });
  }

  private async listen(): Promise<void> {
    const listener = this.sdk.listener(this.account);
    const custody = listenerCustody<DiscordOwnerEventMap>(listener, {
      label: "discord owner gateway",
      publish: this.publish,
      now: this.options.now,
      id: this.options.id,
      // The SDK's own start() stays pending across a recoverable pre-READY
      // close and rejects on its connect timeout, so a close before READY is its call.
      failOnCloseBeforeConnected: false,
      // The SDK stops itself on 4004/4010-4014 and reports only this error.
      terminal: (error) => /non-recoverable code/.test(error.message),
    });
    listener.on("message_create", (event) => {
      this.dispatch(DiscordMessageSchema.safeParse(event), event.id);
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
      msg: "discord owner instance stopped",
    });
  }

  /**
   * One dispatch under the posture: the normalizer keeps the account's own
   * messages out and names a mention of the Owner; `mentions_and_dms` then
   * admits a DM or that mention.
   */
  private dispatch(parsed: z.ZodSafeParseResult<DiscordMessage>, key: string): void {
    const normalizer = this.normalizer;
    if (!parsed.success || normalizer === null) return;
    const message = parsed.data;
    const traceId = newTraceId(this.options.id);
    void handoffInbound({
      dedupe: this.dedupe,
      key,
      traceId,
      now: this.options.now,
      publish: this.publish,
      errorMessage: "discord owner message handling failed",
      rethrowFailure: false,
      handle: async () => {
        const inbound = normalizer.normalize(message);
        if (inbound === null || !this.admits(inbound)) return;
        await requireHandler(this.handler, "discord:owner")({
          ...inbound,
          facts: { ...inbound.facts, receivedBy: "owner" },
        });
      },
    });
  }

  private admits(inbound: Channel.InboundMessage): boolean {
    if (this.posture.intake === "all") return true;
    return inbound.facts.dm || inbound.facts.event === "mention";
  }

  deliver(
    externalId: string,
    payload: Outbound.Payload,
    idempotencyKey: string,
    conversation?: Gateway.Conversation,
  ): Promise<DeliveryReceipt> {
    return deliverThroughDiscord(this.delivery(), externalId, payload, idempotencyKey, conversation);
  }

  async openTyping(externalId: string, conversation?: Gateway.Conversation): Promise<Gateway.Conversation> {
    if (conversation !== undefined) return conversation;
    return { channelId: await discordDmChannel(this.client, externalId, newTraceId(this.options.id)) };
  }

  typing(conversation: Gateway.Conversation): Promise<void> {
    return this.client.typing(conversation.channelId, newTraceId(this.options.id));
  }

  private delivery(): DiscordDelivery {
    return { client: this.client, outbound: this.outbound, publish: this.publish, options: this.options };
  }
}
