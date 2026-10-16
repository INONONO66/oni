import type { PlainValue } from "@openomni/protocol";
import type { SlackOwnerApi, SlackOwnerSdk } from "../../src/provider/slack/owner-sdk";
import type { SlackCall } from "./slack-sdk";

/** A scripted refusal for one SDK method: thrown on every call of it. */
export type OwnerScript = Partial<Record<keyof SlackOwnerApi, Error>>;

/** The Owner's direct channel the fake opens with any user. */
export const OWNER_DM = "D-owner";

/**
 * A scripted stand-in for the SDK user client (#1569 lane 5): records every
 * call with its arguments, exposes the inner web client `singleAttempt` pins,
 * and throws the scripted error for a method when one is set.
 */
export class FakeSlackOwnerClient implements SlackOwnerApi {
  readonly calls: SlackCall[] = [];
  /** The inner `@slack/web-api` client the pin reconfigures; absent until login. */
  client: { retryConfig?: { readonly retries?: number }; rejectRateLimitedCalls?: boolean } | null = null;
  private counter = 0;

  constructor(readonly script: OwnerScript = {}) {}

  private record<T>(method: keyof SlackOwnerApi, args: readonly PlainValue[], value: T): Promise<T> {
    this.calls.push({ method, args });
    const failure = this.script[method];
    return failure === undefined ? Promise.resolve(value) : Promise.reject(failure);
  }

  login(credentials: { token: string; cookie: string }): Promise<object> {
    this.client = {};
    return this.record("login", [credentials.token, credentials.cookie], this);
  }

  testAuth(): Promise<{ user_id: string; team_id: string }> {
    return this.record("testAuth", [], { user_id: "U-owner", team_id: "T1" });
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
    return this.record("openConversation", [users], { channel_id: OWNER_DM });
  }

  /** The calls of one method, by name. */
  of(method: keyof SlackOwnerApi): SlackCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

export function fakeSlackOwnerSdk(script: OwnerScript = {}): {
  readonly sdk: SlackOwnerSdk;
  readonly client: FakeSlackOwnerClient;
} {
  const client = new FakeSlackOwnerClient(script);
  return { client, sdk: { client: () => client } };
}
