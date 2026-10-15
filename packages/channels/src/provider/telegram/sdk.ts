import {
  TelegramBotClient,
  TelegramBotError,
  TelegramBotListener,
} from "agent-messenger/telegrambot";
import type { TelegramBotListenerEventMap } from "agent-messenger/telegrambot";

/**
 * The slice of the agent-messenger Telegram bot SDK this surface speaks
 * (#1569): the long-poll listener only. REST stays on the package's own
 * `TelegramClient` over `fetch-retry` because the SDK client re-sends on
 * network errors and 5xx up to three times with no way to turn that off,
 * takes media as file paths or URLs rather than bytes, and has no
 * `sendChatAction` or `answerCallbackQuery`; custody allows exactly one
 * physical attempt per idempotency key.
 */

/** What the SDK listener needs from its client: the token it polls with. */
export interface TelegramBotApi {
  login(credentials: { token: string }): Promise<object>;
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
    client: () => new TelegramBotClient(),
    // The listener only ever receives the client this same factory built.
    listener: (client, options) =>
      new TelegramBotListener(client as TelegramBotClient, {
        allowedUpdates: [...options.allowedUpdates],
      }),
  };
}

/** Codes after which the SDK listener has stopped polling for good: a revoked token or a second poller. */
const LISTENER_TERMINAL = new Set(["unauthorized", "conflict"]);

export function isTelegramTerminal(error: Error): boolean {
  return error instanceof TelegramBotError && LISTENER_TERMINAL.has(error.code);
}

export { TelegramBotError };
