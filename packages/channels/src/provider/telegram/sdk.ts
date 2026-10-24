import {
  TelegramBotClient,
  TelegramBotError,
  TelegramBotListener,
} from "agent-messenger/telegrambot";
import type { TelegramBotListenerEventMap } from "agent-messenger/telegrambot";
import { TelegramApiError } from "../../errors";
import { transportFailure, type TransportFailure } from "../../support/transport-failure";
import type { AttachmentBounds } from "../../types";
import { z } from "zod";

/**
 * The slice of the agent-messenger Telegram bot SDK this surface speaks
 * (#1569): the long-poll listener and one-attempt REST client. Every request
 * rides this seam, including byte media, typing and callback acknowledgments.
 */

/** What the SDK listener needs from its client: the token it polls with. */
export interface TelegramBotApi {
  login(credentials: { token: string }): Promise<object>;
  sendMessage(
    chatId: string | number,
    text: string,
    options?: {
      parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
      reply_to_message_id?: number;
      message_thread_id?: number;
    },
  ): Promise<{ message_id?: string | number }>;
  sendPhoto(
    chatId: string | number,
    photo: string | { data: Uint8Array; filename: string; contentType?: string },
    options?: { caption?: string; message_thread_id?: number; reply_to_message_id?: number },
  ): Promise<{ message_id?: string | number }>;
  sendDocument(
    chatId: string | number,
    file: string | { data: Uint8Array; filename: string; contentType?: string },
    options?: { caption?: string; message_thread_id?: number; reply_to_message_id?: number },
  ): Promise<{ message_id?: string | number }>;
  sendAudio(chatId: string | number, audio: string | { data: Uint8Array; filename: string; contentType?: string }, options?: { caption?: string; duration?: number; message_thread_id?: number; reply_to_message_id?: number }): Promise<{ message_id?: string | number }>;
  sendVoice(chatId: string | number, voice: string | { data: Uint8Array; filename: string; contentType?: string }, options?: { caption?: string; duration?: number; message_thread_id?: number; reply_to_message_id?: number }): Promise<{ message_id?: string | number }>;
  sendVideo(chatId: string | number, video: string | { data: Uint8Array; filename: string; contentType?: string }, options?: { caption?: string; duration?: number; message_thread_id?: number; reply_to_message_id?: number }): Promise<{ message_id?: string | number }>;
  setMessageReaction(
    chatId: string | number,
    messageId: number,
    reaction: { type: "emoji"; emoji: string }[],
  ): Promise<boolean>;
  sendChatAction(
    chatId: string | number,
    action: "typing",
    options?: { message_thread_id?: number },
  ): Promise<boolean>;
  answerCallbackQuery(id: string): Promise<boolean>;
  downloadFile(fileId: string, bounds: AttachmentBounds): Promise<{ buffer: Uint8Array; file: { file_path?: string }; contentType?: string }>;
}

/** The SDK's listener event map, re-exported so the surface never imports the SDK itself. */
export type TelegramBotEventMap = TelegramBotListenerEventMap;

export interface TelegramBotEvents {
  on<K extends keyof TelegramBotListenerEventMap>(
    event: K,
    listener: (...args: TelegramBotListenerEventMap[K]) => void,
  ): this;
  start(): Promise<void>;
  stop(): void;
}

/** Construction seams: the real SDK in production, scripted fakes in tests. */
export interface TelegramSdk {
  client(): TelegramBotApi;
  listener(
    client: TelegramBotApi,
    options: { readonly allowedUpdates: readonly string[] },
  ): TelegramBotEvents;
}

/**
 * The update classes this surface consumes. Declared on the first poll's
 * `allowed_updates`; `message_reaction` is not a typed SDK event, so every
 * update is read off the raw `telegram_update` event through the surface's
 * own schema.
 */
export const TELEGRAM_ALLOWED_UPDATES: readonly string[] = [
  "message",
  "message_reaction",
  "callback_query",
];

export function telegramSdk(): TelegramSdk {
  return {
    client: () => new CheckedTelegramClient({ retries: 0 }),
    listener: (client, options) => {
      if (!(client instanceof TelegramBotClient))
        throw new TelegramApiError({ message: "Telegram listener requires its SDK client" });
      return new TelegramBotListener(client, {
        allowedUpdates: [...options.allowedUpdates],
      });
    },
  };
}

/** Codes after which the SDK listener has stopped polling for good: a revoked token or a second poller. */
const LISTENER_TERMINAL = new Set(["unauthorized", "conflict"]);

const MessageReceipt = z.object({ message_id: z.union([z.string().min(1), z.number()]) });

function checkedReceipt<T>(message: T): T {
  if (!MessageReceipt.safeParse(message).success)
    throw new TelegramApiError({ message: "Telegram response carried no message id" });
  return message;
}

function checkedAck(ack: boolean): boolean {
  if (ack !== true) throw new TelegramApiError({ message: "Telegram response did not acknowledge the operation" });
  return ack;
}

class CheckedTelegramClient extends TelegramBotClient {
  override async sendMessage(...args: Parameters<TelegramBotClient["sendMessage"]>) {
    return checkedReceipt(await super.sendMessage(...args));
  }
  override async sendPhoto(...args: Parameters<TelegramBotClient["sendPhoto"]>) {
    return checkedReceipt(await super.sendPhoto(...args));
  }
  override async sendDocument(...args: Parameters<TelegramBotClient["sendDocument"]>) {
    return checkedReceipt(await super.sendDocument(...args));
  }
  override async sendAudio(...args: Parameters<TelegramBotClient["sendAudio"]>) {
    return checkedReceipt(await super.sendAudio(...args));
  }
  override async sendVoice(...args: Parameters<TelegramBotClient["sendVoice"]>) {
    return checkedReceipt(await super.sendVoice(...args));
  }
  override async sendVideo(...args: Parameters<TelegramBotClient["sendVideo"]>) {
    return checkedReceipt(await super.sendVideo(...args));
  }
  override async setMessageReaction(...args: Parameters<TelegramBotClient["setMessageReaction"]>) {
    return checkedAck(await super.setMessageReaction(...args));
  }
  override async sendChatAction(...args: Parameters<TelegramBotClient["sendChatAction"]>) {
    return checkedAck(await super.sendChatAction(...args));
  }
  override async answerCallbackQuery(...args: Parameters<TelegramBotClient["answerCallbackQuery"]>) {
    return checkedAck(await super.answerCallbackQuery(...args));
  }
}

export type TelegramFailure = TransportFailure;

export function classifyTelegramFailure(error: Error): TelegramFailure {
  return error instanceof TelegramBotError ? transportFailure(error) : "uncertain";
}

export function isTelegramTerminal(error: Error): boolean {
  return error instanceof TelegramBotError && LISTENER_TERMINAL.has(error.code);
}

export { TelegramBotError, TelegramBotClient, TelegramBotListener };
