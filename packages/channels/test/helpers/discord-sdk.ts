import type { DiscordBotListenerEventMap } from "agent-messenger/discordbot";
import { DiscordBotError } from "agent-messenger/discordbot";
import { sdkResponse } from "./sdk-script";
import type { DiscordBotApi, DiscordBotEvents, DiscordSdk } from "../../src/provider/discord/sdk";

type Handler = (...args: never[]) => void;

/** The SDK's READY info: the bot user and its session. */
export const READY = { user: { id: "bot", username: "oni" }, sessionId: "session" };

/**
 * A scripted stand-in for the SDK gateway listener: the test emits the
 * dispatches Discord would have pushed. `start()` runs the scripted opening
 * and, like the real listener, resolves on READY and rejects on an error
 * before it; a close before READY leaves it pending, as the SDK's does while
 * it reconnects.
 */
export class FakeDiscordListener implements DiscordBotEvents {
  readonly handlers = new Map<string, Handler[]>();
  started = 0;
  stopped = 0;
  intents: number | undefined;

  constructor(
    private readonly onStart: (self: FakeDiscordListener) => void = (self) =>
      self.emit("connected", READY),
  ) {}

  on<K extends keyof DiscordBotListenerEventMap>(
    event: K,
    listener: (...args: DiscordBotListenerEventMap[K]) => void,
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

  emit<K extends keyof DiscordBotListenerEventMap>(
    event: K,
    ...args: DiscordBotListenerEventMap[K]
  ): void {
    for (const handler of this.handlers.get(event) ?? [])
      (handler as (...a: DiscordBotListenerEventMap[K]) => void)(...args);
  }

  /** Pushes one dispatch the way the SDK does: the event spread with `type` set to the dispatch name. */
  dispatch(
    name: "MESSAGE_CREATE" | "MESSAGE_REACTION_ADD" | "INTERACTION_CREATE",
    data: object,
  ): void {
    const event = { ...data, type: name };
    this.emit(name.toLowerCase() as "message_create", event as never);
  }
}

export class FakeDiscordClient implements DiscordBotApi {
  readonly logins: string[] = [];
  readonly calls: Array<{ method: string; channelId?: string; messageId?: string; emoji?: string }> = [];
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

  gatewayConnect(): Promise<{ token: string }> {
    return Promise.resolve({ token: this.logins[0] ?? "" });
  }

  testAuth(): Promise<{ id: string; username: string }> {
    this.check("testAuth");
    return Promise.resolve({ id: "bot", username: "oni" });
  }

  createMessage(channelId: string, _options: { content?: string }): Promise<{ id: string }> {
    this.calls.push({ method: "createMessage", channelId });
    this.check("createMessage");
    return this.respond("createMessage", { id: "m-17" });
  }

  createDm(userId: string): Promise<{ id: string }> {
    this.check("createDm");
    this.calls.push({ method: "createDm", channelId: userId });
    return this.respond("createDm", { id: "D-owner" });
  }

  private async respond<T extends { id: string }>(method: string, fallback: T): Promise<T> {
    let response: Response | undefined;
    try {
      response = await sdkResponse();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const code = "code" in error && typeof error.code === "string" ? error.code : "request_error";
      throw new DiscordBotError(error.message, code);
    }
    if (response === undefined) return fallback;
    if (!response.ok) throw new DiscordBotError(`${method} refused`, "api_error", { httpStatus: response.status });
    const body = (await response.json()) as { id?: string };
    return { id: body.id ?? fallback.id } as T;
  }

  triggerTyping(channelId: string): Promise<void> {
    this.check("triggerTyping");
    this.calls.push({ method: "triggerTyping", channelId });
    return Promise.resolve();
  }

  async respondToInteraction(id: string, token: string): Promise<void> {
    this.calls.push({ method: "respondToInteraction", messageId: id, emoji: token });
    this.check(`respondToInteraction:${id}`);
  }

  addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.check("addReaction");
    this.calls.push({ method: "addReaction", channelId, messageId, emoji });
    return Promise.resolve();
  }

  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.check("removeReaction");
    this.calls.push({ method: "removeReaction", channelId, messageId, emoji });
    return Promise.resolve();
  }
}

export function fakeDiscordSdk(listener?: FakeDiscordListener): {
  readonly sdk: DiscordSdk;
  readonly client: FakeDiscordClient;
  readonly listener: FakeDiscordListener;
} {
  const client = new FakeDiscordClient();
  const events = listener ?? new FakeDiscordListener();
  return {
    client,
    listener: events,
    sdk: {
      client: () => client,
      listener: (_client, options) => {
        events.intents = options.intents;
        return events;
      },
    },
  };
}
