import { describe, expect, test } from "bun:test";
import { DiscordApiError } from "../src/errors";
import { discordOwnerSdk } from "../src/provider/discord/owner-sdk";
import { DiscordBotClient, DiscordBotListener } from "../src/provider/discord/sdk";
import { DISCORD_INTENTS, discordSdk } from "../src/provider/discord/sdk";
import { FakeDiscordOwnerClient } from "./helpers/discord-owner-sdk";
import { emptyVoiceStream, fakeDiscordSdk } from "./helpers/discord-sdk";

/**
 * Pins the SDK facts the Discord surface relies on (#1569): the default seam
 * builds the real client and listener without I/O, the consumed intents
 * include the privileged MESSAGE CONTENT bit, and the real listener's
 * `start()` rejects (not hangs) when the gateway connect is refused.
 */
describe("agent-messenger discord bot SDK seam", () => {
  test("the default seam builds the real client and listener, identifying with the consumed intents (no I/O)", async () => {
    const sdk = discordSdk();
    const client = sdk.client();
    expect(client).toBeInstanceOf(DiscordBotClient);
    await client.login({ token: "offline" });
    const listener = sdk.listener(client, { intents: DISCORD_INTENTS });
    expect(listener).toBeInstanceOf(DiscordBotListener);
    // The SDK would otherwise identify with its own default intents, silently dropping MESSAGE CONTENT.
    expect(Reflect.get(listener, "intents")).toBe(DISCORD_INTENTS);
  });

  test("the consumed intents carry MESSAGE CONTENT, guild and direct messages with reactions", () => {
    const bit = (shift: number) => (DISCORD_INTENTS & (1 << shift)) !== 0;
    expect(DISCORD_INTENTS).toBe(46721);
    expect([0, 7, 9, 10, 12, 13, 15].every(bit)).toBe(true);
    // Presence and member intents are privileged and never requested.
    expect(bit(1) || bit(8)).toBe(false);
  });

  test("the real listener is passed through the injectable voice seam; a foreign listener is refused", async () => {
    const joined: string[] = [];
    const sdk = discordSdk(async (guildId, channelId, options) => {
      joined.push(guildId, channelId, options.speakerId);
      return {
        pcmIn: emptyVoiceStream(), pcmOut: { write: async () => undefined },
        events: emptyVoiceStream(), leave: async () => undefined,
      };
    });
    const client = sdk.client();
    const listener = sdk.listener(client, { intents: DISCORD_INTENTS });
    await sdk.joinVoice("guild", "channel", { listener, speakerId: "owner" });
    expect(joined).toEqual(["guild", "channel", "owner"]);
    expect(() => sdk.joinVoice("guild", "channel",
      { listener: fakeDiscordSdk().listener, speakerId: "owner" })).toThrow(DiscordApiError);
  });

  test("the real listener fails start when the gateway connect is refused, instead of hanging", async () => {
    const refusing = Object.assign(new DiscordBotClient(), {
      gatewayConnect: async (): Promise<{ token: string }> => {
        throw new Error("Discord gateway refused: 401");
      },
    });
    const listener = new DiscordBotListener(refusing, {
      intents: DISCORD_INTENTS,
      connectTimeoutMs: 1_000,
    });
    const errors: string[] = [];
    listener.on("error", (error) => {
      errors.push(error.message);
    });
    await expect(listener.start()).rejects.toThrow("Discord gateway refused: 401");
    listener.stop();
    expect(errors).toEqual(["Discord gateway refused: 401"]);
  });
});

describe("agent-messenger discord owner SDK seam", () => {
  test("the listener rejects a structurally compatible foreign client with a typed error", () => {
    expect(() => discordOwnerSdk().listener(new FakeDiscordOwnerClient())).toThrow(DiscordApiError);
  });

  test("the listener accepts the real owner client", () => {
    const sdk = discordOwnerSdk();
    const listener = sdk.listener(sdk.client());
    expect(listener.constructor.name).toBe("DiscordListener");
    expect(listener.on("error", () => undefined)).toBe(listener);
    listener.stop();
  });
});
