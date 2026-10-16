import { SlackClient, SlackError } from "agent-messenger/slack";

/**
 * The slice of the agent-messenger Slack USER SDK the Owner instance speaks
 * (#1569 lane 5): the Web API as the Owner's own account, logged in with the
 * vault-opened `{token xoxc, cookie d}` the QR login produced. No listener
 * yet (lane 6). The SDK class satisfies this shape structurally; tests pass
 * scripted fakes. The inner `@slack/web-api` client is pinned to one physical
 * attempt by the surface (`singleAttempt`, shared with the bot seam).
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

/** Construction seam: the real SDK in production, scripted fakes in tests. */
export interface SlackOwnerSdk {
  client(): SlackOwnerApi;
}

export function slackOwnerSdk(): SlackOwnerSdk {
  return { client: () => new SlackClient() };
}

/**
 * The user SDK's error class: `code` is the `@slack/web-api` code the SDK
 * forwarded, or the Slack error string when the SDK checked `ok:false`
 * itself. `classifySlackFailure` reads either shape by name.
 */
export { SlackError as SlackOwnerError };
