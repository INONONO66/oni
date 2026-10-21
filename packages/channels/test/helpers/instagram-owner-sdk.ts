import { existsSync, readFileSync } from "node:fs";
import type { PlainValue } from "@oni/protocol";
import type {
  InstagramMessage,
  InstagramOwnerApi,
  InstagramOwnerEventMap,
  InstagramOwnerEvents,
  InstagramOwnerSdk,
} from "../../src/provider/instagram/owner-sdk";

type Handler = (...args: never[]) => void;

/** The account the fake session names. */
export const INSTAGRAM_OWNER_ID = "17841400000001";

/** A session state as the login helper seals it: cookies plus the account's user id. */
export const INSTAGRAM_SESSION = JSON.stringify({
  cookies: "sessionid=abc; ds_user_id=17841400000001",
  device: { phone_id: "p", uuid: "u" },
  user_id: INSTAGRAM_OWNER_ID,
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
export class FakeInstagramOwnerClient implements InstagramOwnerApi {
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
export class FakeInstagramOwnerListener implements InstagramOwnerEvents {
  readonly handlers = new Map<string, Handler[]>();
  started = 0;
  stopped = 0;
  pollInterval: number | undefined;

  constructor(
    private readonly onStart: (self: FakeInstagramOwnerListener) => void = (self) =>
      self.emit("connected", { userId: INSTAGRAM_OWNER_ID, transport: "realtime" }),
  ) {}

  on<K extends keyof InstagramOwnerEventMap>(
    event: K,
    listener: (...args: InstagramOwnerEventMap[K]) => void,
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

  emit<K extends keyof InstagramOwnerEventMap>(event: K, ...args: InstagramOwnerEventMap[K]): void {
    for (const handler of this.handlers.get(event) ?? [])
      (handler as (...a: InstagramOwnerEventMap[K]) => void)(...args);
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

export function fakeInstagramOwnerSdk(
  script: InstagramScript = {},
  listener?: FakeInstagramOwnerListener,
): {
  readonly sdk: InstagramOwnerSdk;
  readonly client: FakeInstagramOwnerClient;
  readonly listener: FakeInstagramOwnerListener;
} {
  const client = new FakeInstagramOwnerClient(script);
  const events = listener ?? new FakeInstagramOwnerListener();
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
