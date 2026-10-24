import { newTraceId } from "../../support/trace";
import { type Channel, type Gateway, Operational, type Outbound } from "@oni/protocol";
import { Dedupe } from "../../support/dedupe";
import { handoffInbound } from "../../support/inbound-handoff";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import { requireHandler } from "../../support/handler-frame";
import { type ListenerCustody, listenerCustody } from "../../support/sdk-listener";
import { translate } from "../../support/translate";
import { DeliveryNotSent, RateLimited, TelegramApiError } from "../../errors";
import { TELEGRAM_MEDIA_LIMITS, TELEGRAM_RENDER } from "./format";
import { TelegramNormalizer } from "./normalizer";
import {
  isTelegramTerminal,
  classifyTelegramFailure,
  TELEGRAM_ALLOWED_UPDATES,
  type TelegramBotApi,
  type TelegramBotEventMap,
  type TelegramSdk,
  telegramSdk,
} from "./sdk";
import {
  type TelegramCallback,
  type TelegramMessage,
  type TelegramReaction,
  TelegramUpdateSchema,
} from "./types";
import type { ProviderOptions } from "../contract";
import type { AttachmentBounds, MediaBytes, PublishPort } from "../../types";
import { attachmentDownload } from "../../support/attachment-download";

/**
 * Telegram over the agent-messenger bot SDK's long-poll listener (#1569): the
 * SDK owns `getUpdates`, its backoff and the offset; this surface owns the
 * bot identity (from the listener's `getMe`), facts-only normalization,
 * inbound dedupe, callback acks, delivery custody and rendering. REST stays
 * through the SDK client with retries disabled, one physical attempt per key.
 * Every update is read off the raw `telegram_update` event through the
 * surface's own schema because `message_reaction` is not a typed SDK event.
 * The SDK advances the offset before dispatch, so a failed handoff is an
 * Operational Error with the dedupe claim released, not a platform redelivery
 * — the same at-least-once remainder Slack keeps after its ack; for the same
 * reason a callback whose answer is still in flight at `stop()` still hands
 * off afterwards (the update is already confirmed; dropping it would lose the
 * tap).
 */
export class TelegramAdapter implements Channel.Surface {
  readonly id = "telegram:bot";

  async download(fileId: string, bounds: AttachmentBounds): Promise<MediaBytes> {
    await this.ready;
    const { buffer, file, contentType } = await attachmentDownload(bounds, () => this.bot.downloadFile(fileId, bounds));
    const path = file.file_path ?? fileId;
    const responseMime = contentType?.split(";")[0];
    const mime = responseMime && responseMime !== "application/octet-stream" ? responseMime : Bun.file(path).type;
    return { bytes: buffer, name: path.slice(path.lastIndexOf("/") + 1), mime };
  }
  private readonly bot: TelegramBotApi;
  private readonly ready: Promise<void>;
  private readonly dedupe: Dedupe;
  private readonly outbound = new DeliveryReconciliation();
  private custody: ListenerCustody | null = null;
  private normalizer: TelegramNormalizer | null = null;
  private handler: Channel.MessageHandler | null = null;

  constructor(
    readonly token: string,
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    private readonly options: ProviderOptions,
    private readonly sdk: TelegramSdk = telegramSdk(),
  ) {
    this.dedupe = new Dedupe(options.now);
    this.bot = sdk.client();
    this.ready = this.bot.login({ token }).then(() => undefined);
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  /** Settles on the listener's `connected` (after its `getMe`); an error before it fails this start. */
  async start(traceId: string): Promise<void> {
    requireHandler(this.handler, "telegram");
    await this.ready;
    const listener = this.sdk.listener(this.bot, { allowedUpdates: TELEGRAM_ALLOWED_UPDATES });
    const custody = listenerCustody<TelegramBotEventMap>(listener, {
      label: "telegram poll",
      publish: this.publish,
      now: this.options.now,
      id: this.options.id,
      // Every failed poll cycle is a cause-less close and the SDK never
      // re-emits `connected`, so the default bound alarms once per process
      // while the SDK's own backoff keeps polling; only a terminal code ends it.
      terminal: isTelegramTerminal,
      onConnected: ({ user }) => {
        this.normalizer = new TelegramNormalizer({
          botId: String(user.id),
          botUsername: user.username ?? "",
        });
        this.publish(Operational.Events.Info, {
          traceId,
          time: this.options.now(),
          component: "server",
          msg: "telegram bot started",
          context: { username: user.username ?? user.first_name, botId: user.id },
        });
      },
    });
    listener.on("telegram_update", (raw) => {
      this.dispatch(raw);
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
      msg: "telegram bot stopped",
    });
  }

  /** One raw update: the message, reaction or callback it carries, in that order, each handed off once. */
  private dispatch(raw: object): void {
    const traceId = newTraceId(this.options.id);
    const update = TelegramUpdateSchema.safeParse(raw);
    if (!update.success) {
      this.publish(Operational.Events.Warn, {
        traceId,
        time: this.options.now(),
        component: "server",
        msg: "telegram update malformed; dropped",
      });
      return;
    }
    if (update.data.message) this.handoff(update.data.message, traceId);
    if (update.data.message_reaction) this.handoff(update.data.message_reaction, traceId);
    const callback = update.data.callback_query;
    if (callback === undefined) return;
    // This acknowledgment only dismisses the client spinner; a refusal must not block the handoff.
    void this.call("telegram.answerCallbackQuery", () => this.bot.answerCallbackQuery(callback.id))
      .catch((error) => {
        this.publish(Operational.Events.Warn, {
          traceId,
          time: this.options.now(),
          component: "server",
          msg: "telegram callback acknowledgment failed; delivering anyway",
          context: { err: String(error) },
        });
      })
      .then(() => this.handoff(callback, traceId));
  }

  private handoff(
    message: TelegramMessage | TelegramReaction | TelegramCallback,
    traceId: string,
  ): void {
    void handoffInbound({
      dedupe: this.dedupe,
      key:
        "id" in message
          ? message.id
          : "new_reaction" in message
            ? `${message.chat.id}:${message.message_id}:${message.new_reaction[0]?.emoji}:${message.user?.id ?? message.actor_chat?.id}`
            : `${message.chat.id}:${message.message_id}`,
      traceId,
      now: this.options.now,
      publish: this.publish,
      errorMessage: "telegram message handling failed",
      rethrowFailure: false,
      handle: () => this.handleMessage(message, traceId),
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
      async (traceId) => {
        await this.ready;
        return await translate(
          payload,
          TELEGRAM_RENDER,
          {
            text: (chunk) => this.sendMarkdown(chatId, chunk, traceId, conversation),
            media: {
              limits: TELEGRAM_MEDIA_LIMITS,
              upload: async (kind, bytes, caption) => {
                const externalMessageId = await this.sendMedia(
                  chatId,
                  kind,
                  bytes,
                  caption,
                  conversation,
                );
                return externalMessageId === undefined ? {} : { externalMessageId };
              },
            },
            // setMessageReaction sets the bot's whole reaction list, so `replaces` needs no second call.
            react: (messageId, emoji) =>
              this.call("telegram.setMessageReaction", () =>
                this.bot.setMessageReaction(chatId, Number(messageId), [{ type: "emoji", emoji }]),
              ).then(() => undefined),
          },
          this.options.media,
        );
      },
      (error) =>
        classifyTelegramFailure(error) === "rejected" ||
        (error instanceof TelegramApiError && error.rejected) ||
        (error instanceof RateLimited && error.status === 429),
      this.publish,
      this.options,
    );
  }

  /** A Telegram chat is addressed directly: the actor id is its DM chat id. */
  openTyping(
    externalId: string,
    conversation?: Gateway.Conversation,
  ): Promise<Gateway.Conversation> {
    return Promise.resolve(conversation ?? { channelId: externalId });
  }

  typing(conversation: Gateway.Conversation): Promise<void> {
    return this.call("telegram.sendChatAction", () =>
      this.bot.sendChatAction(
        conversation.channelId,
        "typing",
        conversation.threadId === undefined
          ? undefined
          : { message_thread_id: Number(conversation.threadId) },
      ),
    ).then(() => undefined);
  }

  private async sendMarkdown(
    channelId: string,
    text: string,
    traceId: string,
    conversation?: Gateway.Conversation,
  ): Promise<string | undefined> {
    try {
      return await this.sendMessage(channelId, text, "MarkdownV2", conversation);
    } catch (error) {
      if (
        !(
          error instanceof TelegramApiError &&
          error.rejected === true &&
          /can't parse entities/i.test(error.message)
        )
      )
        throw error;
      this.publish(Operational.Events.Warn, {
        traceId,
        time: this.options.now(),
        component: "server",
        msg: "telegram markdown rejected — delivered as plain text",
        context: { err: String(error) },
      });
      return await this.sendMessage(channelId, text, undefined, conversation);
    }
  }

  private sendMessage(
    channelId: string,
    text: string,
    parseMode: "MarkdownV2" | undefined,
    conversation?: Gateway.Conversation,
  ): Promise<string | undefined> {
    return this.call("telegram.sendMessage", () =>
      this.bot.sendMessage(channelId, text, {
        ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
        ...(conversation?.threadId === undefined ? {} : { message_thread_id: Number(conversation.threadId) }),
        ...(conversation?.replyToMessageId === undefined ? {} : { reply_to_message_id: Number(conversation.replyToMessageId) }),
      }),
    ).then((message) => message.message_id === undefined ? undefined : String(message.message_id));
  }

  private sendMedia(
    channelId: string,
    kind: "image" | "file",
    media: { readonly bytes: Uint8Array; readonly name: string; readonly mime: string },
    caption: string | undefined,
    conversation?: Gateway.Conversation,
  ): Promise<string | undefined> {
    const options = {
      ...(caption === undefined ? {} : { caption }),
      ...(conversation?.threadId === undefined ? {} : { message_thread_id: Number(conversation.threadId) }),
      ...(conversation?.replyToMessageId === undefined ? {} : { reply_to_message_id: Number(conversation.replyToMessageId) }),
    };
    return this.call(`telegram.${kind === "image" ? "sendPhoto" : "sendDocument"}`, () =>
      kind === "image"
        ? this.bot.sendPhoto(channelId, { data: media.bytes, filename: media.name, contentType: media.mime }, options)
        : this.bot.sendDocument(channelId, { data: media.bytes, filename: media.name, contentType: media.mime }, options),
    ).then((message) => message.message_id === undefined ? undefined : String(message.message_id));
  }

  private async call<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const failure = classifyTelegramFailure(error);
      if (failure === "not_connected")
        throw new DeliveryNotSent({ operation, cause: String(error) });
      throw new TelegramApiError({ message: String(error), rejected: failure === "rejected" });
    }
  }

  private async handleMessage(
    message: TelegramMessage | TelegramReaction | TelegramCallback,
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
      context: { chatId: String("id" in message ? message.message?.chat.id : message.chat.id) },
    });
    await requireHandler(this.handler, "telegram")(inbound);
  }
}
