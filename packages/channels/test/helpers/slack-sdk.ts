import type { SlackBotListenerEventMap } from "agent-messenger/slackbot";
import type { PlainValue } from "@openomni/protocol";
import type {
  SlackBotApi,
  SlackBotEvents,
  SlackSdk,
  SlackThreadMessage,
} from "../../src/provider/slack/sdk";
import { SlackBotError } from "../../src/provider/slack/sdk";

/** One recorded Web API call: the SDK method and its arguments. */
export interface SlackCall {
  readonly method: string;
  readonly args: readonly PlainValue[];
}

type Handler = (...args: never[]) => void;

/**
 * A scripted stand-in for the SDK listener: the test emits the events Slack
 * would have pushed and reads back whether each envelope was acked.
 */
export class FakeSlackListener implements SlackBotEvents {
  readonly handlers = new Map<string, Handler[]>();
  started = 0;
  stopped = 0;
  readonly acked: string[] = [];

  constructor(private readonly onStart: () => void = () => this.emit("connected", {})) {}

  on<K extends keyof SlackBotListenerEventMap>(
    event: K,
    listener: (...args: SlackBotListenerEventMap[K]) => void,
  ): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener as Handler);
    this.handlers.set(event, list);
    return this;
  }

  async start(): Promise<void> {
    this.started += 1;
    this.onStart();
  }

  stop(): void {
    this.stopped += 1;
  }

  emit<K extends keyof SlackBotListenerEventMap>(
    event: K,
    ...args: SlackBotListenerEventMap[K]
  ): void {
    for (const handler of this.handlers.get(event) ?? [])
      (handler as (...a: SlackBotListenerEventMap[K]) => void)(...args);
  }

  private ack(envelopeId: string) {
    let acked = false;
    return () => {
      if (acked) return;
      acked = true;
      this.acked.push(envelopeId);
    };
  }

  /**
   * Pushes one Events API envelope the way the SDK's `dispatchEventsApi`
   * does: the event's own type first, then the `slack_event` catch-all,
   * sharing one idempotent ack.
   */
  eventsApi(envelopeId: string, event: Record<string, PlainValue>): void {
    const args = {
      ack: this.ack(envelopeId),
      envelope_id: envelopeId,
      body: { event },
      event,
    };
    if (typeof event.type === "string") this.emit(event.type as "message", args as never);
    this.emit("slack_event", args as never);
  }

  interactive(envelopeId: string, body: Record<string, PlainValue>): void {
    this.emit("interactive", {
      ack: this.ack(envelopeId),
      envelope_id: envelopeId,
      body,
    } as never);
  }

  slashCommand(envelopeId: string, body: Record<string, PlainValue>): void {
    this.emit("slash_commands", {
      ack: this.ack(envelopeId),
      envelope_id: envelopeId,
      body,
    } as never);
  }

  /** A frame the SDK does not type (`hello`-like unknown envelopes reach `slack_event` bare, with no ack). */
  bareEnvelope(envelope: Record<string, PlainValue>): void {
    this.emit("slack_event", envelope as never);
  }
}

export interface FakeSlackScript {
  readonly identity?: { user_id: string; team_id: string };
  readonly postedTs?: string;
  /** Per-call post outcome (1-based): a message with or without a ts, or the SDK error the platform produced. */
  readonly post?: (call: number) => { ts?: string } | Error;
  readonly threadReplies?: () => Promise<SlackThreadMessage[]>;
  /** Scripted failure per method; a thrown `SlackBotError` reproduces the SDK's own error shape. */
  readonly fail?: Partial<Record<keyof SlackBotApi, () => Error>>;
}

/** The direct channel the fake opens for any user. */
export const DM_CHANNEL = "D-open";

/** Records every Web API call and answers from the script; `login` is a no-op like the SDK's (no I/O). */
export class FakeSlackClient implements SlackBotApi {
  readonly calls: SlackCall[] = [];
  /** The runtime web-client shape `singleAttempt` pins; a fake carries one so the pin has somewhere to land. */
  readonly client: { retryConfig?: { readonly retries?: number }; rejectRateLimitedCalls?: boolean } = {};

  constructor(private readonly script: FakeSlackScript = {}) {}

  private record<T>(method: keyof SlackBotApi, args: readonly PlainValue[], value: T): Promise<T> {
    this.calls.push({ method, args });
    const failure = this.script.fail?.[method];
    return failure === undefined ? Promise.resolve(value) : Promise.reject(failure());
  }

  /** The calls of one method, in order. */
  of(method: keyof SlackBotApi): SlackCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  login(credentials: { token: string }): Promise<object> {
    return this.record("login", [credentials.token], this);
  }

  testAuth(): Promise<{ user_id: string; team_id: string }> {
    return this.record("testAuth", [], this.script.identity ?? { user_id: "UBOT", team_id: "T9" });
  }

  private posts = 0;

  postMessage(
    channel: string,
    text: string,
    options?: { thread_ts?: string },
  ): Promise<{ ts: string }> {
    this.posts += 1;
    const scripted = this.script.post?.(this.posts);
    if (scripted instanceof Error) {
      this.calls.push({ method: "postMessage", args: [channel, text, options ?? {}] });
      return Promise.reject(scripted);
    }
    // A scripted post without a ts is the platform acknowledging without an id (a missing receipt).
    const ts = scripted === undefined ? (this.script.postedTs ?? "999.1") : scripted.ts;
    return this.record("postMessage", [channel, text, options ?? {}], { ts } as { ts: string });
  }

  async getThreadReplies(
    channel: string,
    ts: string,
    options?: { limit?: number },
  ): Promise<SlackThreadMessage[]> {
    this.calls.push({ method: "getThreadReplies", args: [channel, ts, options ?? {}] });
    const failure = this.script.fail?.getThreadReplies;
    if (failure !== undefined) throw failure();
    return this.script.threadReplies === undefined ? [] : await this.script.threadReplies();
  }

  uploadFile(
    channel: string,
    file: Buffer,
    filename: string,
    options?: { thread_ts?: string; initial_comment?: string },
  ): Promise<object> {
    return this.record("uploadFile", [channel, [...file], filename, options ?? {}], { id: "F1" });
  }

  addReaction(channel: string, timestamp: string, emoji: string): Promise<void> {
    return this.record("addReaction", [channel, timestamp, emoji], undefined);
  }

  removeReaction(channel: string, timestamp: string, emoji: string): Promise<void> {
    return this.record("removeReaction", [channel, timestamp, emoji], undefined);
  }

  openDm(userId: string): Promise<string> {
    return this.record("openDm", [userId], DM_CHANNEL);
  }
}

/** The SDK error for a platform `ok:false` answer, as `@slack/web-api` words it and the SDK forwards it. */
export function platformError(error: string): SlackBotError {
  return new SlackBotError(`An API error occurred: ${error}`, "slack_webapi_platform_error");
}

export function fakeSlackSdk(
  script: FakeSlackScript = {},
  listener?: FakeSlackListener,
): {
  readonly sdk: SlackSdk;
  readonly client: FakeSlackClient;
  readonly listener: FakeSlackListener;
  /** What the surface built the listener with; `undefined` until it did. */
  readonly listenerArgs: () => { client: SlackBotApi; appToken: string } | undefined;
} {
  const client = new FakeSlackClient(script);
  const events = listener ?? new FakeSlackListener();
  let listenerArgs: { client: SlackBotApi; appToken: string } | undefined;
  return {
    client,
    listener: events,
    listenerArgs: () => listenerArgs,
    sdk: {
      client: () => client,
      listener: (built, options) => {
        listenerArgs = { client: built, appToken: options.appToken };
        return events;
      },
    },
  };
}
