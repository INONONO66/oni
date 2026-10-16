import { DiscordBotClient, DiscordBotListener, DiscordIntent } from "agent-messenger/discordbot";
import type { DiscordBotListenerEventMap } from "agent-messenger/discordbot";

/**
 * The slice of the agent-messenger Discord bot SDK this surface speaks
 * (#1569): the gateway listener only. REST stays on the package's own
 * `DiscordClient` over `fetch-retry` because the SDK client re-sends on
 * network errors and 5xx up to three times with no way to turn that off, and
 * custody allows exactly one physical attempt per idempotency key.
 */

/** What the SDK listener needs from its client: the token it identifies with. */
export interface DiscordBotApi {
  login(credentials: { token: string }): Promise<object>;
  gatewayConnect(): Promise<{ token: string }>;
}

/** The SDK's gateway event map, re-exported so the surface never imports the SDK itself. */
export type DiscordBotEventMap = DiscordBotListenerEventMap;

export interface DiscordBotEvents {
  on<K extends keyof DiscordBotListenerEventMap>(
    event: K,
    listener: (...args: DiscordBotListenerEventMap[K]) => void,
  ): this;
  start(): Promise<void>;
  stop(): void;
}

/** Construction seams: the real SDK in production, scripted fakes in tests. */
export interface DiscordSdk {
  client(): DiscordBotApi;
  listener(client: DiscordBotApi, options: { readonly intents: number }): DiscordBotEvents;
}

/**
 * The intents this surface consumes. MESSAGE CONTENT is privileged: without
 * the portal switch Discord delivers empty bodies and no error, which is why
 * the provider lists it as an operator precondition.
 */
export const DISCORD_INTENTS: number =
  DiscordIntent.Guilds |
  DiscordIntent.GuildMessages |
  DiscordIntent.GuildMessageReactions |
  DiscordIntent.DirectMessages |
  DiscordIntent.DirectMessageReactions |
  DiscordIntent.MessageContent;

export function discordSdk(): DiscordSdk {
  return {
    client: () => new DiscordBotClient(),
    // The listener only ever receives the client this same factory built.
    listener: (client, options) =>
      new DiscordBotListener(client as DiscordBotClient, { intents: options.intents }),
  };
}
