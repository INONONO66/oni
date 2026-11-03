import { DiscordClient, DiscordError, DiscordListener, loginWithRemoteAuth } from "agent-messenger/discord";
import type { DiscordListenerEventMap } from "agent-messenger/discord";
import { checkedDiscordReceipt, type DiscordApi } from "./sdk";
import { DiscordApiError } from "../../errors";
import { transportFailure, type TransportFailure } from "../../support/transport-failure";

/**
 * The slice of the agent-messenger Discord USER SDK the Account instance
 * speaks (#1569 lane 6): the gateway listener and one-attempt REST client.
 * Every request — the identity check at start included — rides the same
 * account token through this seam. The SDK classes satisfy these shapes
 * structurally; tests pass scripted fakes.
 */
export interface DiscordAccountApi extends Omit<DiscordApi, "createDm"> {
  createDM(userId: string): Promise<{ id?: string }>;
  testAuth(): Promise<{ id: string; username: string }>;
}

/** The SDK's user-gateway event map, re-exported so the surface never imports the SDK itself. */
export type DiscordAccountEventMap = DiscordListenerEventMap;

export interface DiscordAccountEvents {
  on<K extends keyof DiscordListenerEventMap>(
    event: K,
    listener: (...args: DiscordListenerEventMap[K]) => void,
  ): this;
  start(): Promise<void>;
  stop(): void;
}

/** Construction seams: the real SDK in production, scripted fakes in tests. */
export interface DiscordAccountSdk {
  client(): DiscordAccountApi;
  listener(client: DiscordAccountApi): DiscordAccountEvents;
}

function accountListener(client: DiscordAccountApi): DiscordAccountEvents {
  if (!(client instanceof DiscordClient))
    throw new DiscordApiError({ message: "Discord listener requires its SDK client" });
  return new DiscordListener(client);
}

export function discordAccountSdk(): DiscordAccountSdk {
  return {
    client: () => new CheckedDiscordAccountClient({ retries: 0 }),
    listener: accountListener,
  };
}

class CheckedDiscordAccountClient extends DiscordClient {
  override async createMessage(...args: Parameters<DiscordClient["createMessage"]>) {
    return checkedDiscordReceipt(await super.createMessage(...args));
  }
}

export type DiscordAccountFailure = TransportFailure;

export function classifyDiscordAccountFailure(error: Error): DiscordAccountFailure {
  const normalized = error instanceof DiscordError
    ? error
    : new DiscordError(error.message, "network_error", { cause: error });
  return transportFailure(normalized);
}

/**
 * The Account's own sign-in (#1569 lane 5b): Discord's remote-auth QR, shown
 * through `showQr` and scanned with the phone app, yields the account
 * token. Nothing is stored here.
 */
export interface DiscordAccountLoginInput {
  readonly showQr: (url: string) => void | Promise<void>;
  readonly timeoutMs?: number;
}

export async function discordAccountLogin(
  input: DiscordAccountLoginInput,
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
