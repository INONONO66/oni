import { newTraceId } from "../../support/trace";
import { type Channel, type Gateway, Operational, type Outbound } from "@openomni/protocol";
import { Dedupe } from "../../support/dedupe";
import { handoffInbound } from "../../support/inbound-handoff";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { requireHandler } from "../../support/handler-frame";
import { translate } from "../../support/translate";
import { RateLimited, TelegramApiError } from "../../errors";
import { TELEGRAM_RENDER } from "./format";
import { TelegramClient } from "./client";
import { TelegramNormalizer } from "./normalizer";
import { TelegramPoller } from "./poller";
import type { TelegramMessage, TelegramReaction } from "./types";
import type { ProviderOptions } from "../contract";
import type { PublishPort } from "../../types";

export class TelegramAdapter implements Channel.Surface {
  readonly id = "telegram";
  private readonly client: TelegramClient;
  private readonly dedupe: Dedupe;
  private readonly outbound = new DeliveryReconciliation();
  private normalizer: TelegramNormalizer | null = null;
  private poller: TelegramPoller | null = null;
  private handler: Channel.MessageHandler | null = null;

  constructor(
    token: string,
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
  ) {
    this.dedupe = new Dedupe(options.now);
    this.client = new TelegramClient(token, publish, options.now, options.run);
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  async start(traceId: string): Promise<void> {
    requireHandler(this.handler, "telegram");
    const me = await this.client.getMe(traceId);
    const botId = String(me.id);
    const botUsername = me.username ?? "";
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "telegram bot started",
      context: { username: me.username ?? me.first_name, botId: me.id },
    });
    this.normalizer = new TelegramNormalizer({ botId, botUsername });
    this.poller = new TelegramPoller(
      this.client,
      {
        onMessage: (message) => {
          const messageTraceId = newTraceId(this.options.id);
          return handoffInbound({
            dedupe: this.dedupe,
            key:
              "new_reaction" in message
                ? `${message.chat.id}:${message.message_id}:${message.new_reaction[0]?.emoji}:${message.user?.id ?? message.actor_chat?.id}`
                : `${message.chat.id}:${message.message_id}`,
            traceId: messageTraceId,
            now: this.options.now,
            publish: this.publish,
            errorMessage: "telegram message handling failed",
            rethrowFailure: true,
            handle: () => this.handleMessage(message, messageTraceId),
          });
        },
      },
      this.publish,
      this.options,
    );
    void this.poller.start();
  }

  stop(traceId: string): void {
    this.poller?.stop();
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "telegram bot stopped",
    });
  }

  /**
   * Existing-agent delivery: a registered ActorEndpoint's externalId is a
   * Telegram chat id — deliver there and report the platform message id of
   * the final chunk (the message a reply would reference).
   */
  deliver(
    externalId: string,
    payload: Outbound.Payload,
    idempotencyKey: string,
    conversation?: Gateway.Conversation,
  ): Promise<DeliveryReceipt> {
    const chatId = conversation?.channelId ?? externalId;
    return deliverKeyed(
      this.outbound,
      idempotencyKey,
      (traceId) =>
        translate(
          payload,
          TELEGRAM_RENDER,
          {
            text: (chunk) => this.client.sendMarkdown(chatId, chunk, traceId, conversation),
            media: async (kind, bytes, caption) => {
              const externalMessageId = await this.client.sendMedia(chatId, kind, bytes, caption, traceId, conversation);
              return externalMessageId === undefined ? {} : { externalMessageId };
            },
            react: (messageId, emoji) => this.client.react(chatId, messageId, emoji, traceId),
          },
          this.options.media,
        ),
      (error) =>
        (error instanceof TelegramApiError && error.rejected) ||
        (error instanceof RateLimited && error.status === 429),
      this.publish,
      this.options,
    );
  }

  typing(externalId: string, conversation?: Gateway.Conversation): Promise<void> {
    return this.client.typing(conversation?.channelId ?? externalId, newTraceId(this.options.id), conversation);
  }

  private async handleMessage(
    message: TelegramMessage | TelegramReaction,
    traceId: string,
  ): Promise<void> {
    if (!this.normalizer) return;
    const inbound = this.normalizer.normalize(message);
    if (!inbound) return;
    this.publish(Operational.Events.Debug, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "telegram message received",
      context: { chatId: String(message.chat.id) },
    });
    await requireHandler(this.handler, "telegram")(inbound);
  }
}
