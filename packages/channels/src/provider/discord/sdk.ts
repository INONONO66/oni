import {
  DiscordBotClient,
  DiscordBotError,
  DiscordBotListener,
  DiscordIntent,
} from "agent-messenger/discordbot";
import type { DiscordBotListenerEventMap } from "agent-messenger/discordbot";
import { DiscordApiError } from "../../errors";
import { transportFailure, type TransportFailure } from "../../support/transport-failure";
import { z } from "zod";

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
    client: () => new CheckedDiscordBotClient({ retries: 0 }),
    listener: (client, options) => {
      if (!(client instanceof DiscordBotClient))
        throw new DiscordApiError({ message: "Discord listener requires its SDK client" });
      return new DiscordBotListener(client, { intents: options.intents });
    },
  };
}

const MessageReceipt = z.object({ id: z.string().min(1) });

export function checkedDiscordReceipt<T>(message: T): T {
  if (!MessageReceipt.safeParse(message).success)
    throw new DiscordApiError({ message: "Discord response carried no string id" });
  return message;
}

class CheckedDiscordBotClient extends DiscordBotClient {
  override async createMessage(...args: Parameters<DiscordBotClient["createMessage"]>) {
    return checkedDiscordReceipt(await super.createMessage(...args));
  }
}

export type DiscordFailure = TransportFailure;

export function classifyDiscordFailure(error: Error): DiscordFailure {
  return error instanceof DiscordBotError ? transportFailure(error) : "uncertain";
}

export { DiscordBotClient, DiscordBotListener };
