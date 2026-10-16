import type {
  DiscordOwnerApi,
  DiscordOwnerEventMap,
  DiscordOwnerEvents,
  DiscordOwnerSdk,
} from "../../src/provider/discord/owner-sdk";

type Handler = (...args: never[]) => void;

/** The user gateway's READY: the Owner's own account. */
export const OWNER_READY = { user: { id: "U-owner", username: "owner" }, sessionId: "session-owner" };

/**
 * A scripted stand-in for the SDK's user-gateway listener (#1569 lane 6):
 * the test emits the dispatches the account would have received. Like the
 * real one, `start()` resolves on READY and rejects on an error before it.
 */
export class FakeDiscordOwnerListener implements DiscordOwnerEvents {
  readonly handlers = new Map<string, Handler[]>();
  started = 0;
  stopped = 0;

  constructor(
    private readonly onStart: (self: FakeDiscordOwnerListener) => void = (self) =>
      self.emit("connected", OWNER_READY),
  ) {}

  on<K extends keyof DiscordOwnerEventMap>(
    event: K,
    listener: (...args: DiscordOwnerEventMap[K]) => void,
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

  emit<K extends keyof DiscordOwnerEventMap>(event: K, ...args: DiscordOwnerEventMap[K]): void {
    for (const handler of this.handlers.get(event) ?? [])
      (handler as (...a: DiscordOwnerEventMap[K]) => void)(...args);
  }

  /** Pushes one dispatch the way the SDK does: the event spread with `type` set to the dispatch name. */
  dispatch(name: "MESSAGE_CREATE" | "MESSAGE_REACTION_ADD", data: object): void {
    const event = { ...data, type: name };
    this.emit(name.toLowerCase() as "message_create", event as never);
  }
}

export class FakeDiscordOwnerClient implements DiscordOwnerApi {
  readonly logins: string[] = [];

  login(credentials: { token: string }): Promise<object> {
    this.logins.push(credentials.token);
    return Promise.resolve(this);
  }
}

export function fakeDiscordOwnerSdk(listener?: FakeDiscordOwnerListener): {
  readonly sdk: DiscordOwnerSdk;
  readonly client: FakeDiscordOwnerClient;
  readonly listener: FakeDiscordOwnerListener;
} {
  const client = new FakeDiscordOwnerClient();
  const events = listener ?? new FakeDiscordOwnerListener();
  return { client, listener: events, sdk: { client: () => client, listener: () => events } };
}
