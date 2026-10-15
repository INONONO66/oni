import { SlackBotClient, SlackBotError, SlackBotListener } from "agent-messenger/slackbot";
import type { SlackBotListenerEventMap } from "agent-messenger/slackbot";
import { SlackApiError } from "../../errors";

/**
 * The slice of the agent-messenger Slack bot SDK this surface speaks (#1569).
 * The SDK classes satisfy these shapes structurally; tests pass scripted
 * fakes. Everything platform-shaped (Socket Mode, acks, reconnects, the Web
 * API) is the SDK's; identity, facts, custody and rendering stay here.
 */

/** One message of a thread as the SDK maps `conversations.replies`. */
export interface SlackThreadMessage {
  readonly ts: string;
  readonly user?: string;
  /** Integration posts carry a username instead of a user id. */
  readonly username?: string;
  readonly text: string;
}

export interface SlackBotApi {
  login(credentials: { token: string }): Promise<object>;
  testAuth(): Promise<{ user_id: string; team_id: string }>;
  postMessage(
    channel: string,
    text: string,
    options?: { thread_ts?: string },
  ): Promise<{ ts: string }>;
  getThreadReplies(
    channel: string,
    ts: string,
    options?: { limit?: number },
  ): Promise<SlackThreadMessage[]>;
  uploadFile(
    channel: string,
    file: Buffer,
    filename: string,
    options?: { thread_ts?: string; initial_comment?: string },
  ): Promise<object>;
  addReaction(channel: string, timestamp: string, emoji: string): Promise<void>;
  removeReaction(channel: string, timestamp: string, emoji: string): Promise<void>;
  /**
   * The bot's direct channel with a user (`conversations.open`). The SDK has
   * no such call; it is needed because `files.completeUploadExternal` and
   * `reactions.add` take a channel id and refuse a bare user id.
   */
  openDm(userId: string): Promise<string>;
}

/** What one `slack_event` carries: Events API args with an ack, or a bare envelope the SDK did not type. */
export type SlackEventArgs = SlackBotListenerEventMap["slack_event"][0];
/** The Events API member of `SlackEventArgs`: the one carrying the ack. */
export type SlackEventsApiArgs = Extract<
  SlackEventArgs,
  { ack: SlackBotListenerEventMap["message"][0]["ack"] }
>;

export interface SlackBotEvents {
  on<K extends keyof SlackBotListenerEventMap>(
    event: K,
    listener: (...args: SlackBotListenerEventMap[K]) => void,
  ): this;
  start(): Promise<void>;
  stop(): void;
}

/** Construction seams: the real SDK in production, scripted fakes in tests. */
export interface SlackSdk {
  client(): SlackBotApi;
  listener(client: SlackBotApi, options: { readonly appToken: string }): SlackBotEvents;
}

/** The `@slack/web-api` client the SDK keeps private; only these members are touched. */
interface InnerWebClient {
  retryConfig?: { readonly retries?: number };
  rejectRateLimitedCalls?: boolean;
  conversations: {
    open(args: {
      users: string;
    }): Promise<{ ok?: boolean; error?: string; channel?: { id?: string } }>;
  };
  apps: {
    connections: {
      open(args: { token: string }): Promise<{ ok?: boolean; error?: string; url?: string }>;
    };
  };
}

function innerWebClient(client: object): InnerWebClient {
  const inner = (client as { client?: InnerWebClient | null }).client;
  if (inner === undefined || inner === null)
    throw new SlackApiError({ message: "slack sdk client carries no web client after login" });
  return inner;
}

/**
 * The SDK leaves `@slack/web-api` on its default ten-retries-in-thirty-minutes
 * policy, which re-posts after a reset or a 5xx the platform may already have
 * accepted. Custody permits exactly one physical attempt per idempotency key
 * (kernel-contract: only `not_sent` resends), so the inner client is pinned
 * to a single attempt and an immediate typed rate-limit refusal. The SDK's
 * own bounded rate-limit retry (three, honoring retry-after) stays: a 429 is
 * proof the platform refused, so a resend is safe.
 */
export function singleAttempt(client: object): void {
  const inner = innerWebClient(client);
  inner.retryConfig = { retries: 0 };
  inner.rejectRateLimitedCalls = true;
}

/**
 * The SDK client plus the two calls the surface needs that the SDK does not
 * offer. Both ride the one pinned inner client: `appsConnectionsOpen` in the
 * SDK builds a fresh web client per attempt under the default retry policy,
 * which would hold `start()` for up to half an hour on a network failure.
 */
class CustodySlackBotClient extends SlackBotClient implements SlackBotApi {
  async openDm(userId: string): Promise<string> {
    const response = await innerWebClient(this).conversations.open({ users: userId });
    if (!response.ok || response.channel?.id === undefined)
      throw new SlackBotError(
        `An API error occurred: ${response.error ?? "conversations.open returned no channel"}`,
        "slack_webapi_platform_error",
      );
    return response.channel.id;
  }

  override async appsConnectionsOpen(appToken: string): Promise<{ url: string }> {
    const response = await innerWebClient(this).apps.connections.open({ token: appToken });
    if (!response.ok || response.url === undefined)
      throw new SlackBotError(
        `An API error occurred: ${response.error ?? "apps.connections.open returned no url"}`,
        response.error ?? "slack_webapi_platform_error",
      );
    return { url: response.url };
  }
}

export function slackSdk(): SlackSdk {
  return {
    client: () => new CustodySlackBotClient(),
    // The listener only ever receives the client this same factory built.
    listener: (client, options) => {
      if (!(client instanceof SlackBotClient))
        throw new SlackApiError({ message: "slack listener requires the client the seam built" });
      return new SlackBotListener(client, { appToken: options.appToken });
    },
  };
}

/** `@slack/web-api` codes the SDK forwards verbatim on `SlackBotError.code`. */
const PLATFORM_REFUSED = "slack_webapi_platform_error";
const RATE_LIMITED = "slack_webapi_rate_limited_error";
const HTTP_ERROR = "slack_webapi_http_error";
const REQUEST_ERROR = "slack_webapi_request_error";
/**
 * The SDK's own refusals raised before any request leaves the process. Every
 * other SDK code (`unknown_error`, `file_not_found`, …) can follow a request
 * the platform already accepted and keeps custody.
 */
const SDK_PREFLIGHT = new Set([
  "missing_token",
  "invalid_token_type",
  "not_authenticated",
  "missing_app_token",
  "invalid_app_token_type",
]);
/** Request failures proving the connection was never established (support/deliver `NotConnected`). */
const NEVER_CONNECTED = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/;

export type SlackFailure = "rejected" | "not_connected" | "uncertain";

/**
 * Physical evidence from one SDK failure. `rejected` and `not_connected`
 * prove the platform never accepted the message; everything else keeps
 * custody as `unknown`. A single-attempt client (`singleAttempt`) is assumed:
 * with retries, an http or request error could follow an accepted post.
 */
export function classifySlackFailure(error: Error): SlackFailure {
  if (!(error instanceof SlackBotError)) return "uncertain";
  if (error.code === REQUEST_ERROR)
    return NEVER_CONNECTED.test(error.message) ? "not_connected" : "uncertain";
  if (error.code === HTTP_ERROR) return "uncertain";
  // Platform `ok:false`, a typed rate-limit refusal after the SDK's bounded
  // retries, and the SDK's own preflight refusals all mean nothing was posted.
  return error.code === PLATFORM_REFUSED ||
    error.code === RATE_LIMITED ||
    SDK_PREFLIGHT.has(error.code)
    ? "rejected"
    : "uncertain";
}

/**
 * A platform error naming a state that already holds (`already_reacted`,
 * `no_reaction`). The SDK drops the Slack error string into the message
 * (`An API error occurred: <error>`), so the name is matched there.
 */
export function isSettledState(error: Error, states: readonly string[]): boolean {
  return (
    error instanceof SlackBotError &&
    error.code === PLATFORM_REFUSED &&
    states.some((state) => error.message.endsWith(`: ${state}`))
  );
}

export { SlackBotError };
