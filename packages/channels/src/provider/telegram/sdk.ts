import {
  TelegramBotClient,
  TelegramBotError,
  TelegramBotListener,
} from "agent-messenger/telegrambot";
import type { TelegramBotListenerEventMap } from "agent-messenger/telegrambot";

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
    options?: { caption?: string; message_thread_id?: number },
  ): Promise<{ message_id?: string | number }>;
  sendDocument(
    chatId: string | number,
    file: string | { data: Uint8Array; filename: string; contentType?: string },
    options?: { caption?: string; message_thread_id?: number },
  ): Promise<{ message_id?: string | number }>;
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
  downloadFile(fileId: string): Promise<{ buffer: Uint8Array; file: { file_path?: string } }>;
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
    client: () => new TelegramBotClient({ retries: 0 }),
    // The listener only ever receives the client this same factory built.
    listener: (client, options) =>
      new TelegramBotListener(client as TelegramBotClient, {
        allowedUpdates: [...options.allowedUpdates],
      }),
  };
}

/** Codes after which the SDK listener has stopped polling for good: a revoked token or a second poller. */
const LISTENER_TERMINAL = new Set(["unauthorized", "conflict"]);

const SDK_PREFLIGHT = new Set([
  "not_authenticated",
  "missing_token",
  "invalid_token",
  "empty_message",
  "file_too_large",
]);
const NEVER_CONNECTED = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/;

export type TelegramFailure = "rejected" | "not_connected" | "uncertain";

export function classifyTelegramFailure(error: Error): TelegramFailure {
  if (!(error instanceof TelegramBotError)) return "uncertain";
  if (error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500)
    return "rejected";
  if (NEVER_CONNECTED.test(error.message) || NEVER_CONNECTED.test(error.code))
    return "not_connected";
  return SDK_PREFLIGHT.has(error.code) ? "rejected" : "uncertain";
}

export function isTelegramTerminal(error: Error): boolean {
  return error instanceof TelegramBotError && LISTENER_TERMINAL.has(error.code);
}

export { TelegramBotError };
