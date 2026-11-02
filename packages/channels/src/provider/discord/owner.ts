import { type Channel, type Gateway, Operational, type Outbound } from "@oni/protocol";
import type { z } from "zod";
import { Dedupe } from "../../support/dedupe";
import { type DeliveryReceipt, DeliveryReconciliation } from "../../support/deliver";
import { instanceHandler, requireHandler } from "../../support/handler-frame";
import { handoffInbound } from "../../support/inbound-handoff";
import { type ListenerCustody, listenerCustody } from "../../support/sdk-listener";
import { newTraceId } from "../../support/trace";
import type { PublishPort } from "../../types";
import type { AccountIdentity, ProviderOptions } from "../contract";
import { type DiscordDelivery, deliverThroughDiscord, discordDmChannel } from "./delivery";
import { DiscordNormalizer } from "./normalizer";
import {
  type DiscordOwnerApi,
  type DiscordOwnerEventMap,
  type DiscordOwnerSdk,
  discordOwnerSdk,
  classifyDiscordOwnerFailure,
} from "./owner-sdk";
import { type DiscordMessage, DiscordMessageSchema } from "./types";

/**
 * Discord as the Owner's own account (#1569 lane 6): the declared
 * instance, logged in with the vault-opened account token the remote-auth
 * login produced. Delivery and typing ride the SDK client under the bare
 * token with retries disabled. The gateway listener emits message facts;
 * the router's rules decide which messages to deliver.
 */
export class DiscordOwnerAdapter implements Channel.Surface {
  get id(): string { return this.options.instance; }
  readonly config: Channel.Config = {};

  private readonly account: DiscordOwnerApi;
  private readonly ready: Promise<void>;
  private readonly sdk: DiscordOwnerSdk;
  private readonly dedupe: Dedupe;
  private readonly outbound = new DeliveryReconciliation();
  private custody: ListenerCustody | null = null;
  private normalizer: DiscordNormalizer | null = null;
  private handler: Channel.MessageHandler | null = null;
  private selfId: string | null = null;

  constructor(
    credentials: { token: string },
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
    sdk: DiscordOwnerSdk = discordOwnerSdk(),
  ) {
    this.sdk = sdk;
    this.account = sdk.client();
    this.ready = this.account.login(credentials).then(() => undefined);
    this.dedupe = new Dedupe(options.now);
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = instanceHandler(this.id, handler);
  }

  /**
   * The account identity is verified before the instance counts as mounted;
   * a refused login fails this start. The gateway
   * listener then opens, settling on READY and failing this start on an
   * error before it.
   */
  async start(traceId: string): Promise<void> {
    await this.ready;
    // The Owner SDK disables request replay but may wait for its rate-limit bucket.
    const identity = await this.account.testAuth();
    this.selfId = identity.id;
    this.normalizer = new DiscordNormalizer(identity.id);
    const listens = this.handler !== null;
    if (listens) await this.listen();
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "discord owner instance started",
      context: {
        userId: identity.id,
        username: identity.username,
        listener: listens,
      },
    });
  }

  /** The account's Discord user id (#1600), the shape a Discord endpoint takes. */
  accountIdentity(): AccountIdentity | undefined {
    return this.selfId === null ? undefined : { externalId: this.selfId };
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

  /** Normalize each observed message before the router evaluates its rules. */
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
        if (inbound === null) return;
        await requireHandler(this.handler, this.id)({
          ...inbound,
          facts: { ...inbound.facts, receivedBy: "owner" },
        });
      },
    });
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
    await this.ready;
    return {
      channelId: await discordDmChannel(this.account, externalId),
    };
  }

  typing(conversation: Gateway.Conversation): Promise<void> {
    return this.account.triggerTyping(conversation.channelId);
  }

  private delivery(): DiscordDelivery {
    return {
      client: this.account,
      ready: this.ready,
      classify: classifyDiscordOwnerFailure,
      outbound: this.outbound,
      publish: this.publish,
      options: this.options,
    };
  }
}
