import { existsSync, readFileSync } from "node:fs";
import type { PlainValue } from "@oni/protocol";
import type {
  InstagramMessage,
  InstagramAccountApi,
  InstagramAccountEventMap,
  InstagramAccountEvents,
  InstagramAccountSdk,
} from "../../src/provider/instagram/account-sdk.js";

type Handler = (...args: never[]) => void;

/** The account the fake session names. */
export const INSTAGRAM_ACCOUNT_ID = "17841400000001";

/** A session state as the login helper seals it: cookies plus the account's user id. */
export const INSTAGRAM_SESSION = JSON.stringify({
  cookies: "sessionid=abc; ds_user_id=17841400000001",
  device: { phone_id: "p", uuid: "u" },
  user_id: INSTAGRAM_ACCOUNT_ID,
});

export interface InstagramCall {
  readonly method: string;
  readonly args: readonly PlainValue[];
}

/** A scripted failure per send method: thrown on every call of it. */
export type InstagramScript = Partial<Record<"sendMessage" | "sendMessageToUser", Error>>;

/**
 * A scripted stand-in for the SDK client (#1569 lane 7): `loadSession`
 * reads the file the surface writes (and records that it existed), the
 * session path records what the surface left behind, sends are recorded.
 */
export class FakeInstagramAccountClient implements InstagramAccountApi {
  readonly calls: InstagramCall[] = [];
  /** What `loadSession` found at the path, and the path the surface set afterwards. */
  loaded: { readonly existed: boolean; readonly session: string | null } | null = null;
  sessionPath: string | null = null;
  private userId: string | null = null;
  private counter = 0;

  constructor(private readonly script: InstagramScript = {}) {}

  async loadSession(path: string): Promise<void> {
    const existed = existsSync(path);
    const session = existed ? readFileSync(path, "utf8") : null;
    this.loaded = { existed, session };
    this.sessionPath = path;
    const parsed: { user_id?: string } = session === null ? {} : JSON.parse(session);
    this.userId = parsed.user_id ?? null;
  }

  setSessionPath(path: string): void {
    this.sessionPath = path;
  }

  getUserId(): string | null {
    return this.userId;
  }

  private record(method: keyof InstagramScript, args: readonly PlainValue[]): Promise<{ id: string }> {
    this.calls.push({ method, args });
    const failure = this.script[method];
    if (failure !== undefined) return Promise.reject(failure);
    this.counter += 1;
    return Promise.resolve({ id: `ig-${this.counter}` });
  }

  sendMessage(threadId: string, text: string): Promise<{ id: string }> {
    return this.record("sendMessage", [threadId, text]);
  }

  sendMessageToUser(userPk: string, text: string): Promise<{ id: string }> {
    return this.record("sendMessageToUser", [userPk, text]);
  }

  of(method: keyof InstagramScript): InstagramCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

/** A scripted stand-in for the SDK's hybrid inbox listener: the test emits what the inbox would have shown. */
export class FakeInstagramAccountListener implements InstagramAccountEvents {
  readonly handlers = new Map<string, Handler[]>();
  started = 0;
  stopped = 0;
  pollInterval: number | undefined;

  constructor(
    private readonly onStart: (self: FakeInstagramAccountListener) => void = (self) =>
      self.emit("connected", { userId: INSTAGRAM_ACCOUNT_ID, transport: "realtime" }),
  ) {}

  on<K extends keyof InstagramAccountEventMap>(
    event: K,
    listener: (...args: InstagramAccountEventMap[K]) => void,
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

  emit<K extends keyof InstagramAccountEventMap>(event: K, ...args: InstagramAccountEventMap[K]): void {
    for (const handler of this.handlers.get(event) ?? [])
      (handler as (...a: InstagramAccountEventMap[K]) => void)(...args);
  }

  /** One inbox message as the SDK summarizes it. */
  message(summary: Partial<InstagramMessage> & Pick<InstagramMessage, "id" | "thread_id" | "from">): void {
    this.emit("message", {
      timestamp: "1700000000",
      is_outgoing: false,
      type: "text",
      ...summary,
    });
  }
}

export function fakeInstagramAccountSdk(
  script: InstagramScript = {},
  listener?: FakeInstagramAccountListener,
): {
  readonly sdk: InstagramAccountSdk;
  readonly client: FakeInstagramAccountClient;
  readonly listener: FakeInstagramAccountListener;
} {
  const client = new FakeInstagramAccountClient(script);
  const events = listener ?? new FakeInstagramAccountListener();
  return {
    client,
    listener: events,
    sdk: {
      client: () => client,
      listener: (_client, options) => {
        events.pollInterval = options.pollInterval;
        return events;
      },
      loginClient: () => {
        throw new Error("the fake seam signs nothing in");
      },
    },
  };
}
