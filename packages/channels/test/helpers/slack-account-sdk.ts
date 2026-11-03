import type { PlainValue } from "@oni/protocol";
import type {
  SlackAccountApi,
  SlackAccountEventMap,
  SlackAccountEvents,
  SlackAccountSdk,
} from "../../src/provider/slack/account-sdk.js";
import type { SlackHuddleHandle } from "../../src/provider/slack/account-sdk.js";
import type { SlackCall } from "./slack-sdk.js";

type Handler = (...args: never[]) => void;

/** The RTM hello the account's listener reports: the Account's own user and workspace. */
const ACCOUNT_HELLO = { self: { id: "U-account" }, team: { id: "T1" } };

/**
 * A scripted stand-in for the SDK's RTM listener (#1569 lane 6): the test
 * emits the frames the account would have seen. `start()` runs the scripted
 * opening — hello by default — like the real one resolving before hello.
 */
export class FakeSlackAccountListener implements SlackAccountEvents {
  readonly handlers = new Map<string, Handler[]>();
  started = 0;
  stopped = 0;

  constructor(
    private readonly onStart: (self: FakeSlackAccountListener) => void = (self) =>
      self.emit("connected", ACCOUNT_HELLO),
  ) {}

  on<K extends keyof SlackAccountEventMap>(
    event: K,
    listener: (...args: SlackAccountEventMap[K]) => void,
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

  emit<K extends keyof SlackAccountEventMap>(event: K, ...args: SlackAccountEventMap[K]): void {
    for (const handler of this.handlers.get(event) ?? [])
      (handler as (...a: SlackAccountEventMap[K]) => void)(...args);
  }

  /** One RTM message frame as the account sees it (no `channel_type`; a DM is a `D…` channel). */
  message(frame: {
    channel: string;
    user?: string;
    text?: string;
    ts: string;
    thread_ts?: string;
    subtype?: string;
  }): void {
    this.emit("message", { type: "message", ...frame });
  }

  reaction(frame: { user: string; reaction: string; channel: string; ts: string; itemUser?: string }): void {
    this.emit("reaction_added", {
      type: "reaction_added",
      user: frame.user,
      reaction: frame.reaction,
      item: { type: "message", channel: frame.channel, ts: frame.ts },
      ...(frame.itemUser === undefined ? {} : { item_user: frame.itemUser }),
      event_ts: `${frame.ts}1`,
    });
  }
}

/** A scripted refusal for one SDK method: thrown on every call of it. */
export type AccountScript = Partial<Record<keyof SlackAccountApi, Error>>;

/** The Account's direct channel the fake opens with any user. */
export const ACCOUNT_DM = "D-account";

/**
 * A scripted stand-in for the SDK user client (#1569 lane 5): records every
 * call with its arguments, exposes the inner web client `singleAttempt` pins,
 * and throws the scripted error for a method when one is set.
 */
export class FakeSlackAccountClient implements SlackAccountApi {
  readonly calls: SlackCall[] = [];
  /** The inner `@slack/web-api` client the pin reconfigures; absent until login. */
  client: { retryConfig?: { readonly retries?: number }; rejectRateLimitedCalls?: boolean } | null = null;
  private counter = 0;

  constructor(readonly script: AccountScript = {}) {}

  private record<T>(method: keyof SlackAccountApi, args: readonly PlainValue[], value: T): Promise<T> {
    this.calls.push({ method, args });
    const failure = this.script[method];
    return failure === undefined ? Promise.resolve(value) : Promise.reject(failure);
  }

  login(credentials: { token: string; cookie: string }): Promise<object> {
    this.client = {};
    return this.record("login", [credentials.token, credentials.cookie], this);
  }

  testAuth(): Promise<{ user_id: string; team_id: string }> {
    return this.record("testAuth", [], { user_id: "U-account", team_id: "T1" });
  }

  sendMessage(channel: string, text: string, threadTs?: string): Promise<{ ts: string }> {
    this.counter += 1;
    return this.record("sendMessage", [channel, text, threadTs ?? null], { ts: `1700.${this.counter}` });
  }

  addReaction(channel: string, ts: string, emoji: string): Promise<void> {
    return this.record("addReaction", [channel, ts, emoji], undefined);
  }

  removeReaction(channel: string, ts: string, emoji: string): Promise<void> {
    return this.record("removeReaction", [channel, ts, emoji], undefined);
  }

  openConversation(users: string): Promise<{ channel_id: string }> {
    return this.record("openConversation", [users], { channel_id: ACCOUNT_DM });
  }

  /** The calls of one method, by name. */
  of(method: keyof SlackAccountApi): SlackCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

export function fakeSlackAccountSdk(
  script: AccountScript = {},
  listener?: FakeSlackAccountListener,
): {
  readonly sdk: SlackAccountSdk;
  readonly client: FakeSlackAccountClient;
  readonly listener: FakeSlackAccountListener;
  /** What the surface built the listener with; `undefined` until it did. */
  readonly listenerClient: () => SlackAccountApi | undefined;
  readonly joins: { workspaceId: string; channelId: string; speakerId: string; mode?: "join" | "call"; credentials: { token: string; cookie: string } }[];
  readonly setJoin: (join: SlackAccountSdk["joinHuddle"]) => void;
} {
  const client = new FakeSlackAccountClient(script);
  const events = listener ?? new FakeSlackAccountListener();
  let built: SlackAccountApi | undefined;
  const joins: { workspaceId: string; channelId: string; speakerId: string; mode?: "join" | "call"; credentials: { token: string; cookie: string } }[] = [];
  let join: SlackAccountSdk["joinHuddle"] = async () => {
    throw new Error("unscripted huddle join");
  };
  return {
    client,
    listener: events,
    listenerClient: () => built,
    joins,
    setJoin: (next: SlackAccountSdk["joinHuddle"]) => { join = next; },
    sdk: {
      client: () => client,
      listener: (account) => {
        built = account;
        return events;
      },
      joinHuddle: (workspaceId, channelId, options) => {
        joins.push({ workspaceId, channelId, speakerId: options.speakerId, mode: options.mode, credentials: options.credentials });
        return join(workspaceId, channelId, options);
      },
    },
  };
}

/** One event of the external SDK's huddle stream. */
export type HuddleEvent = SlackHuddleHandle["events"] extends AsyncIterable<infer T> ? T : never;

/** The external SDK's already-ready handle, with a controllable event stream. */
export function fakeHuddle() {
  const events: HuddleEvent[] = [];
  let wake = Promise.withResolvers<void>();
  let closed = false;
  let leaves = 0;
  return {
    emit(event: (typeof events)[number]) { events.push(event); wake.resolve(); },
    get leaves() { return leaves; },
    handle: {
      pcmIn: (async function* (): AsyncGenerator<Uint8Array, void, void> { yield new Uint8Array([1, 0, 2, 0]); })(),
      pcmOut: { write: async (_pcm: Uint8Array) => undefined },
      events: (async function* (): AsyncGenerator<HuddleEvent, void, void> {
        while (!closed || events.length > 0) {
          const next = events.shift();
          if (next !== undefined) yield next;
          else { await wake.promise; wake = Promise.withResolvers<void>(); }
        }
      })(),
      leave: async () => { leaves += 1; closed = true; wake.resolve(); },
    } satisfies SlackHuddleHandle,
  };
}
