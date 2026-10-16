import { TelegramApiError } from "../../errors";
import { type Gateway, Operational, type PlainValue } from "@openomni/protocol";
import { z } from "zod";
import { fetchWithRetry } from "../../support/fetch-retry";
import type { ChannelClient, EffectRunner, MediaBytes, PublishPort } from "../../types";

/** Telegram error envelope carries the flood-wait hint the retry helper reads. */
const RetryAfterSchema = z.object({
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});
const EnvelopeSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  result: z.json().optional(),
});
/** `sendMessage` result — Telegram sends a numeric id; absence means no id to report. */
const SentMessageSchema = z.object({
  message_id: z.union([z.number(), z.string()]).optional(),
});
const TrueSchema = z.literal(true);

/** `sendPhoto` takes a `photo` field, `sendDocument` a `document` field. */
const MEDIA_METHOD = { image: ["sendPhoto", "photo"], file: ["sendDocument", "document"] } as const;

function conversationParams(
  conversation: Gateway.Conversation | undefined,
): Record<string, number> {
  return {
    ...(conversation?.threadId === undefined
      ? {}
      : { message_thread_id: Number(conversation.threadId) }),
    ...(conversation?.replyToMessageId === undefined
      ? {}
      : { reply_to_message_id: Number(conversation.replyToMessageId) }),
  };
}

export class TelegramClient implements ChannelClient {
  private readonly baseUrl: string;

  constructor(
    token: string,
    private readonly publish: PublishPort,
    private readonly now: () => number,
    private readonly run: EffectRunner,
  ) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async send(channelId: string, text: string, traceId: string): Promise<string | undefined> {
    return await this.sendMessage(channelId, text, traceId);
  }

  /**
   * MarkdownV2 send with a plain-text floor: rendering is a nice-to-have and
   * a parse rejection must never lose the message, so Telegram's entity-parse
   * refusal downgrades this one send to plain text (recorded as a warning).
   */
  async sendMarkdown(
    channelId: string,
    text: string,
    traceId: string,
    conversation?: Gateway.Conversation,
  ): Promise<string | undefined> {
    try {
      return await this.sendMessage(channelId, text, traceId, "MarkdownV2", conversation);
    } catch (error) {
      if (
        !(
          error instanceof TelegramApiError &&
          error.rejected &&
          /can't parse entities/i.test(error.message)
        )
      )
        throw error;
      this.publish(Operational.Events.Warn, {
        traceId,
        time: this.now(),
        component: "server",
        msg: "telegram markdown rejected — delivered as plain text",
        context: { err: String(error) },
      });
      return await this.sendMessage(channelId, text, traceId, undefined, conversation);
    }
  }

  /** `threadId` is a forum topic; `replyToMessageId` quotes the message answered. */
  private async sendMessage(
    channelId: string,
    text: string,
    traceId: string,
    parseMode?: string,
    conversation?: Gateway.Conversation,
  ): Promise<string | undefined> {
    const message = await this.api("sendMessage", traceId, SentMessageSchema, {
      chat_id: channelId,
      text,
      ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
      ...conversationParams(conversation),
    });
    return message.message_id === undefined ? undefined : String(message.message_id);
  }

  /** One attachment as a multipart upload; the caption is plain text (no entity parsing to refuse). */
  async sendMedia(
    channelId: string,
    kind: "image" | "file",
    media: MediaBytes,
    caption: string | undefined,
    traceId: string,
    conversation?: Gateway.Conversation,
  ): Promise<string | undefined> {
    const [method, field] = MEDIA_METHOD[kind];
    const form = new FormData();
    form.set("chat_id", channelId);
    form.set(field, new Blob([media.bytes], { type: media.mime }), media.name);
    if (caption !== undefined) form.set("caption", caption);
    for (const [key, value] of Object.entries(conversationParams(conversation)))
      form.set(key, String(value));
    const message = await this.request(method, traceId, SentMessageSchema, { body: form });
    return message.message_id === undefined ? undefined : String(message.message_id);
  }

  /** `setMessageReaction` replaces the bot's reaction set on one message with this emoji. */
  async react(channelId: string, messageId: string, emoji: string, traceId: string): Promise<void> {
    await this.api("setMessageReaction", traceId, TrueSchema, {
      chat_id: channelId,
      message_id: Number(messageId),
      reaction: [{ type: "emoji", emoji }],
    });
  }

  /** `sendChatAction typing` shows "typing…" for about five seconds. */
  async typing(
    channelId: string,
    traceId: string,
    conversation?: Gateway.Conversation,
  ): Promise<void> {
    await this.api("sendChatAction", traceId, TrueSchema, {
      chat_id: channelId,
      action: "typing",
      ...(conversation?.threadId === undefined
        ? {}
        : { message_thread_id: Number(conversation.threadId) }),
    });
  }

  /** This acknowledgment only dismisses the client spinner; failure must not block handoff. */
  async answerCallbackQuery(id: string, traceId: string): Promise<void> {
    await this.api("answerCallbackQuery", traceId, TrueSchema, { callback_query_id: id });
  }

  private api<T>(
    method: string,
    traceId: string,
    schema: z.ZodType<T>,
    params?: Record<string, PlainValue>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request(method, traceId, schema, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params ?? {}),
      signal,
    });
  }

  private async request<T>(
    method: string,
    traceId: string,
    schema: z.ZodType<T>,
    init: Pick<RequestInit, "headers" | "body" | "signal">,
  ): Promise<T> {
    const url = `${this.baseUrl}/${method}`;
    const response = await fetchWithRetry(
      url,
      { method: "POST", ...init },
      {
        traceId,
        run: this.run,
        publish: this.publish,
        retryAfterSchema: RetryAfterSchema.transform((hint) => hint.parameters?.retry_after ?? 5),
        label: `telegram/${method}`,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new TelegramApiError({
        message: `Telegram API ${method} failed (${response.status}): ${body}`,
        rejected: response.status >= 400 && response.status < 500,
      });
    }

    const envelope = EnvelopeSchema.safeParse(await response.json());
    if (!envelope.success) {
      throw new TelegramApiError({
        message: `Telegram API ${method} returned a malformed envelope`,
      });
    }
    if (!envelope.data.ok) {
      throw new TelegramApiError({
        message: `Telegram API ${method}: ${envelope.data.description ?? "Unknown error"}`,
        rejected: true,
      });
    }
    const result = schema.safeParse(envelope.data.result);
    if (!result.success) {
      throw new TelegramApiError({ message: `Telegram API ${method} returned a malformed result` });
    }
    return result.data;
  }
}
