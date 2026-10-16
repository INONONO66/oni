import type { PlainValue } from "@openomni/protocol";
import type {
  KakaoTalkMessage,
  KakaoTalkOwnerApi,
  KakaoTalkOwnerEventMap,
  KakaoTalkOwnerEvents,
  KakaoTalkOwnerSdk,
} from "../../src/provider/kakaotalk/owner-sdk";

type Handler = (...args: never[]) => void;

/** The account the fake speaks as. */
export const KAKAO_OWNER = { user_id: "1001", nickname: "ino" };

export interface KakaoCall {
  readonly method: string;
  readonly args: readonly PlainValue[];
}

export interface KakaoScript {
  /** The shape of each chat the fake knows; an unknown chat makes `getChat` throw. */
  readonly chats?: Readonly<Record<string, { type: number | string; active_members: number }>>;
  /** A scripted send outcome: a thrown error, or a refused status (the SDK's synthetic −1 is a socket closed before the reply). */
  readonly send?: Error | { readonly success: false; readonly status_code: number };
}

/** A scripted stand-in for the SDK client (#1569 lane 7): every call recorded, chats and sends scripted. */
export class FakeKakaoTalkOwnerClient implements KakaoTalkOwnerApi {
  readonly calls: KakaoCall[] = [];
  closed = 0;
  private counter = 0;

  constructor(private readonly script: KakaoScript = {}) {}

  login(credentials: { oauthToken: string; userId: string; deviceUuid?: string; deviceType?: "pc" | "tablet" }): Promise<object> {
    this.calls.push({ method: "login", args: [credentials.oauthToken, credentials.userId, credentials.deviceUuid ?? null, credentials.deviceType ?? null] });
    return Promise.resolve(this);
  }

  getProfile(): Promise<{ user_id: string; nickname: string }> {
    this.calls.push({ method: "getProfile", args: [] });
    return Promise.resolve(KAKAO_OWNER);
  }

  getChat(chatId: string): Promise<{ type: number | string; active_members: number }> {
    this.calls.push({ method: "getChat", args: [chatId] });
    const chat = this.script.chats?.[chatId];
    return chat === undefined ? Promise.reject(new Error(`unknown chat ${chatId}`)) : Promise.resolve(chat);
  }

  sendMessage(chatId: string, text: string): Promise<{ success: boolean; status_code: number; log_id: string }> {
    this.calls.push({ method: "sendMessage", args: [chatId, text] });
    const outcome = this.script.send;
    if (outcome instanceof Error) return Promise.reject(outcome);
    if (outcome !== undefined) return Promise.resolve({ ...outcome, log_id: "" });
    this.counter += 1;
    return Promise.resolve({ success: true, status_code: 0, log_id: `log-${this.counter}` });
  }

  sendTyping(chatId: string): Promise<{ success: boolean }> {
    this.calls.push({ method: "sendTyping", args: [chatId] });
    return Promise.resolve({ success: true });
  }

  close(): void {
    this.closed += 1;
  }

  of(method: string): KakaoCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

/** A scripted stand-in for the SDK's LOCO push listener: the test emits what the session would have pushed. */
export class FakeKakaoTalkOwnerListener implements KakaoTalkOwnerEvents {
  readonly handlers = new Map<string, Handler[]>();
  started = 0;
  stopped = 0;
  /** The SDK's own guard: `start()` is a no-op while the listener counts itself running — a drop leaves it so; a start error and `stop()` clear it. */
  running = false;
  private starting = false;

  constructor(
    private readonly onStart: (self: FakeKakaoTalkOwnerListener) => void = (self) =>
      self.emit("connected", { userId: KAKAO_OWNER.user_id }),
  ) {}

  on<K extends keyof KakaoTalkOwnerEventMap>(
    event: K,
    listener: (...args: KakaoTalkOwnerEventMap[K]) => void,
  ): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener as Handler);
    this.handlers.set(event, list);
    return this;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.started += 1;
    this.starting = true;
    try {
      this.onStart(this);
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.running = false;
    this.stopped += 1;
  }

  emit<K extends keyof KakaoTalkOwnerEventMap>(event: K, ...args: KakaoTalkOwnerEventMap[K]): void {
    if (event === "error" && this.starting) this.running = false;
    for (const handler of this.handlers.get(event) ?? [])
      (handler as (...a: KakaoTalkOwnerEventMap[K]) => void)(...args);
  }

  /** One pushed message as the SDK reports it. */
  message(event: Pick<KakaoTalkMessage, "chat_id" | "log_id" | "author_id" | "message"> & Partial<KakaoTalkMessage>): void {
    this.emit("message", {
      type: "MSG",
      author_name: null,
      message_type: 1,
      attachment: null,
      sent_at: 1_700_000_000,
      ...event,
    });
  }
}

export function fakeKakaoTalkOwnerSdk(
  script: KakaoScript = {},
  listener?: FakeKakaoTalkOwnerListener,
): {
  readonly sdk: KakaoTalkOwnerSdk;
  readonly client: FakeKakaoTalkOwnerClient;
  readonly listener: FakeKakaoTalkOwnerListener;
} {
  const client = new FakeKakaoTalkOwnerClient(script);
  const events = listener ?? new FakeKakaoTalkOwnerListener();
  return { client, listener: events, sdk: { client: () => client, listener: () => events } };
}
