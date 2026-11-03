import type {
  DiscordAccountApi,
  DiscordAccountEventMap,
  DiscordAccountEvents,
  DiscordAccountSdk,
} from "../../src/provider/discord/account-sdk.js";

type Handler = (...args: never[]) => void;

/** The user gateway's READY: a user account. */
export const ACCOUNT_READY = { user: { id: "U-account", username: "account" }, sessionId: "session-account" };

/**
 * A scripted stand-in for the SDK's user-gateway listener (#1569 lane 6):
 * the test emits the dispatches the account would have received. Like the
 * real one, `start()` resolves on READY and rejects on an error before it.
 */
export class FakeDiscordAccountListener implements DiscordAccountEvents {
  readonly handlers = new Map<string, Handler[]>();
  started = 0;
  stopped = 0;

  constructor(
    private readonly onStart: (self: FakeDiscordAccountListener) => void = (self) =>
      self.emit("connected", ACCOUNT_READY),
  ) {}

  on<K extends keyof DiscordAccountEventMap>(
    event: K,
    listener: (...args: DiscordAccountEventMap[K]) => void,
  ): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener as Handler);
    this.handlers.set(event, list);
    return this;
  }

  start(): Promise<void> {
    this.started += 1;
    const settled = Promise.withResolvers<void>();
    this.on("connected", () => settled.resolve());
    this.on("error", (error) => settled.reject(error));
    this.onStart(this);
    return settled.promise;
  }

  stop(): void {
    this.stopped += 1;
  }

  emit<K extends keyof DiscordAccountEventMap>(event: K, ...args: DiscordAccountEventMap[K]): void {
    for (const handler of this.handlers.get(event) ?? [])
      (handler as (...a: DiscordAccountEventMap[K]) => void)(...args);
  }

  /** Pushes one dispatch the way the SDK does: the event spread with `type` set to the dispatch name. */
  dispatch(name: "MESSAGE_CREATE" | "MESSAGE_REACTION_ADD", data: object): void {
    const event = { ...data, type: name };
    this.emit(name.toLowerCase() as "message_create", event as never);
  }
}

export class FakeDiscordAccountClient implements DiscordAccountApi {
  readonly logins: string[] = [];
  readonly calls: Array<{ method: string; channelId?: string }> = [];

  login(credentials: { token: string }): Promise<object> {
    this.logins.push(credentials.token);
    return Promise.resolve(this);
  }

  testAuth(): Promise<{ id: string; username: string }> {
    this.calls.push({ method: "testAuth" });
    return Promise.resolve({ id: "U-account", username: "account" });
  }

  createMessage(channelId: string): Promise<{ id: string }> {
    this.calls.push({ method: "createMessage", channelId });
    return Promise.resolve({ id: "m-1" });
  }

  createDM(userId: string): Promise<{ id: string }> {
    this.calls.push({ method: "createDM", channelId: userId });
    return Promise.resolve({ id: "D-account" });
  }

  triggerTyping(channelId: string): Promise<void> {
    this.calls.push({ method: "triggerTyping", channelId });
    return Promise.resolve();
  }

  addReaction(): Promise<void> {
    return Promise.resolve();
  }

  removeReaction(): Promise<void> {
    return Promise.resolve();
  }
}

export function fakeDiscordAccountSdk(listener?: FakeDiscordAccountListener): {
  readonly sdk: DiscordAccountSdk;
  readonly client: FakeDiscordAccountClient;
  readonly listener: FakeDiscordAccountListener;
} {
  const client = new FakeDiscordAccountClient();
  const events = listener ?? new FakeDiscordAccountListener();
  return { client, listener: events, sdk: { client: () => client, listener: () => events } };
}
