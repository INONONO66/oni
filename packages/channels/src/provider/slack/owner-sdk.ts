import { SlackClient, SlackError, SlackListener } from "agent-messenger/slack";
import type { SlackListenerEventMap } from "agent-messenger/slack";

/**
 * The slice of the agent-messenger Slack USER SDK the Owner instance speaks
 * (#1569 lanes 5 and 6): the Web API as the Owner's own account, logged in
 * with the vault-opened `{token xoxc, cookie d}` the QR login produced, and
 * the RTM listener that sees what the account sees. The SDK classes satisfy
 * these shapes structurally; tests pass scripted fakes. The inner
 * `@slack/web-api` client is pinned to one physical attempt by the surface
 * (`singleAttempt`, shared with the bot seam).
 */
export interface SlackOwnerApi {
  login(credentials: { token: string; cookie: string }): Promise<object>;
  testAuth(): Promise<{ user_id: string; team_id: string }>;
  sendMessage(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>;
  addReaction(channel: string, ts: string, emoji: string): Promise<void>;
  removeReaction(channel: string, ts: string, emoji: string): Promise<void>;
  /** The Owner's direct channel with a user (`conversations.open`). */
  openConversation(users: string): Promise<{ channel_id: string }>;
}

/** The SDK's RTM event map, re-exported so the surface never imports the SDK itself. */
export type SlackOwnerEventMap = SlackListenerEventMap;

/**
 * The RTM listener over the account's session: `rtm.connect`, a websocket
 * the SDK pings and reopens with its own unbounded backoff, every frame the
 * account can see. Lifecycle is the custody wrapper's (`support/sdk-listener`).
 */
export interface SlackOwnerEvents {
  on<K extends keyof SlackListenerEventMap>(
    event: K,
    listener: (...args: SlackListenerEventMap[K]) => void,
  ): this;
  start(): Promise<void>;
  stop(): void;
}

/** Construction seams: the real SDK in production, scripted fakes in tests. */
export interface SlackOwnerSdk {
  client(): SlackOwnerApi;
  listener(client: SlackOwnerApi): SlackOwnerEvents;
}

export function slackOwnerSdk(): SlackOwnerSdk {
  return {
    client: () => new SlackClient(),
    // The listener only ever receives the client this same factory built.
    listener: (client) => new SlackListener(client as SlackClient),
  };
}

/**
 * The user SDK's error class: `code` is the `@slack/web-api` code the SDK
 * forwarded, or the Slack error string when the SDK checked `ok:false`
 * itself. `classifySlackFailure` reads either shape by name.
 */
export { SlackError as SlackOwnerError };
