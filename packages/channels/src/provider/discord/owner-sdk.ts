import { DiscordClient, DiscordListener } from "agent-messenger/discord";
import type { DiscordListenerEventMap } from "agent-messenger/discord";

/**
 * The slice of the agent-messenger Discord USER SDK the Owner instance
 * speaks (#1569 lane 6): the gateway listener and the login that holds its
 * token. Every request — the identity check at start included — rides the
 * package's own `DiscordClient` under the account token, for the same
 * reason as the bot: the SDK client re-sends 429/5xx up to three times
 * with no off switch, and custody allows one physical attempt per
 * idempotency key. The SDK classes satisfy these shapes structurally; tests
 * pass scripted fakes.
 */
export interface DiscordOwnerApi {
  /** Holds the token the gateway identifies with; no request leaves here. */
  login(credentials: { token: string }): Promise<object>;
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
    client: () => new DiscordClient(),
    // The listener only ever receives the client this same factory built.
    listener: (client) => new DiscordListener(client as DiscordClient),
  };
}
