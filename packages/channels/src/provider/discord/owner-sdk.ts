import { DiscordClient, DiscordError, DiscordListener, loginWithRemoteAuth } from "agent-messenger/discord";
import type { DiscordListenerEventMap } from "agent-messenger/discord";
import type { DiscordApi } from "./sdk";

/**
 * The slice of the agent-messenger Discord USER SDK the Owner instance
 * speaks (#1569 lane 6): the gateway listener and one-attempt REST client.
 * Every request — the identity check at start included — rides the same
 * account token through this seam. The SDK classes satisfy these shapes
 * structurally; tests pass scripted fakes.
 */
export interface DiscordOwnerApi extends Omit<DiscordApi, "createDm"> {
  createDM(userId: string): Promise<{ id?: string }>;
  testAuth(): Promise<{ id: string; username: string }>;
}

/** The SDK's user-gateway event map, re-exported so the surface never imports the SDK itself. */
export type DiscordOwnerEventMap = DiscordListenerEventMap;

export interface DiscordOwnerEvents {
  on<K extends keyof DiscordListenerEventMap>(
    event: K,
    listener: (...args: DiscordListenerEventMap[K]) => void,
  ): this;
  start(): Promise<void>;
  stop(): void;
}

/** Construction seams: the real SDK in production, scripted fakes in tests. */
export interface DiscordOwnerSdk {
  client(): DiscordOwnerApi;
  listener(client: DiscordOwnerApi): DiscordOwnerEvents;
}

export function discordOwnerSdk(): DiscordOwnerSdk {
  return {
    client: () => new DiscordClient({ retries: 0 }),
    // The listener only ever receives the client this same factory built.
    listener: (client) => new DiscordListener(client as unknown as DiscordClient),
  };
}

const SDK_PREFLIGHT = new Set([
  "not_authenticated",
  "missing_token",
  "invalid_token",
  "empty_message",
  "file_too_large",
]);
const NEVER_CONNECTED = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/;

export type DiscordOwnerFailure = "rejected" | "not_connected" | "uncertain";

export function classifyDiscordOwnerFailure(error: Error): DiscordOwnerFailure {
  if (!(error instanceof DiscordError)) return "uncertain";
  if (error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500)
    return "rejected";
  if (NEVER_CONNECTED.test(error.message) || NEVER_CONNECTED.test(error.code))
    return "not_connected";
  return SDK_PREFLIGHT.has(error.code) ? "rejected" : "uncertain";
}


/**
 * The Owner's own sign-in (#1569 lane 5b): Discord's remote-auth QR, shown
 * through `showQr` and scanned with the phone app, yields the account
 * token. Nothing is stored here.
 */
export interface DiscordOwnerLoginInput {
  readonly showQr: (url: string) => void | Promise<void>;
  readonly timeoutMs?: number;
}

export async function discordOwnerLogin(
  input: DiscordOwnerLoginInput,
  login: typeof loginWithRemoteAuth = loginWithRemoteAuth,
): Promise<{ token: string; userId?: string; username?: string }> {
  const session = await login({
    onQrUrl: input.showQr,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  return {
    token: session.token,
    ...(session.user === null ? {} : { userId: session.user.id, username: session.user.username }),
  };
}
