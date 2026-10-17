import type { TelegramBotListenerEventMap } from "agent-messenger/telegrambot";
import { TelegramBotError } from "agent-messenger/telegrambot";
import type { PlainValue } from "@openomni/protocol";
import type {
  TelegramBotApi,
  TelegramBotEvents,
  TelegramSdk,
} from "../../src/provider/telegram/sdk";
import { sdkResponse } from "./sdk-script";

type Handler = (...args: never[]) => void;

/** The SDK's `connected` info: the bot user `getMe` answered with. */
export const ME = { user: { id: 42, is_bot: true, first_name: "Omni", username: "omni_bot" } };

/**
 * A scripted stand-in for the SDK long-poll listener: the test pushes the
 * updates Telegram would have returned. `start()` runs the scripted opening
 * (`connected` by default), like the real listener after `getMe`.
 */
export class FakeTelegramListener implements TelegramBotEvents {
  readonly handlers = new Map<string, Handler[]>();
  started = 0;
  stopped = 0;
  allowedUpdates: readonly string[] | undefined;

  constructor(
    private readonly onStart: (self: FakeTelegramListener) => void = (self) =>
      self.emit("connected", ME),
  ) {}

  on<K extends keyof TelegramBotListenerEventMap>(
    event: K,
    listener: (...args: TelegramBotListenerEventMap[K]) => void,
  ): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener as Handler);
    this.handlers.set(event, list);
    return this;
  }

  async start(): Promise<void> {
    this.started += 1;
    this.onStart(this);
  }

  stop(): void {
    this.stopped += 1;
  }

  emit<K extends keyof TelegramBotListenerEventMap>(
    event: K,
    ...args: TelegramBotListenerEventMap[K]
  ): void {
    for (const handler of this.handlers.get(event) ?? [])
      (handler as (...a: TelegramBotListenerEventMap[K]) => void)(...args);
  }

  /** Pushes one raw update the way the SDK's `dispatch` does for `telegram_update`. */
  update(update: Record<string, PlainValue>): void {
    this.emit("telegram_update", update as never);
  }
}

export class FakeTelegramClient implements TelegramBotApi {
  readonly logins: string[] = [];
  readonly calls: Array<{ method: string; chatId?: string | number; options?: object }> = [];
  private readonly failures = new Map<string, Error>();

  fail(method: string, error: Error): void {
    this.failures.set(method, error);
  }

  private check(method: string): void {
    const error = this.failures.get(method);
    if (error !== undefined) {
      this.failures.delete(method);
      throw error;
    }
  }

  login(credentials: { token: string }): Promise<object> {
    this.logins.push(credentials.token);
    return Promise.resolve(this);
  }

  sendMessage(chatId: string | number, text: string, options?: object): Promise<{ message_id: number | string }> {
    this.calls.push({ method: "sendMessage", chatId, options: { text, ...options } });
    this.check("sendMessage");
    return this.respond({ message_id: 42 });
  }

  sendPhoto(chatId: string | number, _photo: string | { data: Uint8Array; filename: string; contentType?: string }, options?: { caption?: string; message_thread_id?: number }): Promise<{ message_id: number | string }> {
    this.check("sendPhoto");
    this.calls.push({ method: "sendPhoto", chatId, options });
    return this.respond({ message_id: 17 });
  }

  sendDocument(chatId: string | number, _file: string | { data: Uint8Array; filename: string; contentType?: string }, options?: { caption?: string; message_thread_id?: number }): Promise<{ message_id: number | string }> {
    this.check("sendDocument");
    this.calls.push({ method: "sendDocument", chatId, options });
    return this.respond({ message_id: 17 });
  }

  setMessageReaction(chatId: string | number, messageId: number, reaction: { type: "emoji"; emoji: string }[]): Promise<boolean> {
    this.check("setMessageReaction");
    this.calls.push({ method: "setMessageReaction", chatId, options: { messageId, reaction } });
    return Promise.resolve(true);
  }

  sendChatAction(chatId: string | number, action: "typing", options?: object): Promise<boolean> {
    this.check("sendChatAction");
    this.calls.push({ method: "sendChatAction", chatId, options: { action, ...options } });
    return Promise.resolve(true);
  }

  downloadFile(fileId: string): Promise<{ buffer: Uint8Array; file: { file_path?: string } }> {
    this.calls.push({ method: "downloadFile", options: { fileId } });
    return Promise.resolve({ buffer: new TextEncoder().encode(fileId), file: { file_path: `documents/${fileId}.bin` } });
  }

  answerCallbackQuery(id: string): Promise<boolean> {
    this.calls.push({ method: "answerCallbackQuery", options: { id } });
    this.check("answerCallbackQuery");
    return Promise.resolve(true);
  }

  private async respond<T extends { message_id: number | string }>(fallback: T): Promise<T> {
    let response: Response | undefined;
    try {
      response = await sdkResponse();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const code = "code" in error && typeof error.code === "string" ? error.code : "request_error";
      throw new TelegramBotError(error.message, code);
    }
    if (response === undefined) return fallback;
    if (!response.ok) throw new TelegramBotError("request refused", "api_error", { httpStatus: response.status });
    const body = (await response.json()) as { result?: { message_id?: number | string } };
    const value = body.result?.message_id;
    return { message_id: value === undefined ? fallback.message_id : value } as T;
  }
}

export function fakeTelegramSdk(listener?: FakeTelegramListener): {
  readonly sdk: TelegramSdk;
  readonly client: FakeTelegramClient;
  readonly listener: FakeTelegramListener;
} {
  const client = new FakeTelegramClient();
  const events = listener ?? new FakeTelegramListener();
  return {
    client,
    listener: events,
    sdk: {
      client: () => client,
      listener: (_client, options) => {
        events.allowedUpdates = options.allowedUpdates;
        return events;
      },
    },
  };
}
