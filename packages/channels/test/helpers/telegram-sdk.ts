import type { TelegramBotListenerEventMap } from "agent-messenger/telegrambot";
import type { PlainValue } from "@openomni/protocol";
import type {
  TelegramBotApi,
  TelegramBotEvents,
  TelegramSdk,
} from "../../src/provider/telegram/sdk";

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

  login(credentials: { token: string }): Promise<object> {
    this.logins.push(credentials.token);
    return Promise.resolve(this);
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
