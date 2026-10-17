import {
  DiscordBotClient,
  DiscordBotError,
  DiscordBotListener,
  DiscordIntent,
} from "agent-messenger/discordbot";
import type { DiscordBotListenerEventMap } from "agent-messenger/discordbot";

/**
 * The slice of the agent-messenger Discord bot SDK this surface speaks
 * (#1569): the gateway listener and one-attempt REST client. Every platform
 * request rides this seam so delivery custody can distinguish refusal from an
 * uncertain result without a second physical attempt.
 */

/** What the SDK listener needs from its client: the token it identifies with. */
export interface DiscordApi {
  login(credentials: { token: string }): Promise<object>;
  createMessage(
    channelId: string,
    options: {
      content?: string;
      files?: {
        data: Uint8Array;
        filename: string;
        contentType?: string;
        }[];
      reply_to?: string;
    },
  ): Promise<{ id?: string }>;
  createDm(userId: string): Promise<{ id?: string }>;
  triggerTyping(channelId: string): Promise<void>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
}

export interface DiscordBotApi extends DiscordApi {
  gatewayConnect(): Promise<{ token: string }>;
  respondToInteraction(id: string, token: string, type?: number): Promise<void>;
  testAuth(): Promise<{ id: string; username: string }>;
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
    client: () => new DiscordBotClient({ retries: 0 }),
    // The listener only ever receives the client this same factory built.
    listener: (client, options) =>
      new DiscordBotListener(client as DiscordBotClient, { intents: options.intents }),
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

export type DiscordFailure = "rejected" | "not_connected" | "uncertain";

function isDiscordError(error: Error): error is DiscordBotError {
  return error instanceof DiscordBotError;
}

export function classifyDiscordFailure(error: Error): DiscordFailure {
  if (!isDiscordError(error)) return "uncertain";
  if (error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500)
    return "rejected";
  if (NEVER_CONNECTED.test(error.message) || NEVER_CONNECTED.test(error.code))
    return "not_connected";
  return SDK_PREFLIGHT.has(error.code) ? "rejected" : "uncertain";
}
