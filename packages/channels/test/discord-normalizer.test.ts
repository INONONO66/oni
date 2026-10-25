import { describe, expect, it } from "bun:test";
import { DiscordNormalizer, discordCall } from "../src/provider/discord/normalizer";

const normalizer = new DiscordNormalizer("BOT");
const message = {
  id: "m",
  channel_id: "c",
  author: { id: "u", username: "user" },
  content: "hello",
};

describe("Discord ingress facts", () => {
  it("normalizes voice joins from parsed gateway state without a chat prompt", () => {
    const state = {
      guild_id: "guild", channel_id: "voice", user_id: "owner", session_id: "voice-session",
      deaf: false, mute: false, self_deaf: false, self_mute: false, self_video: false, suppress: false,
    };
    expect(discordCall(state, 42, "gateway-session", "BOT")?.facts).toEqual({
      eventId: "call:guild:owner:gateway-session:42", event: "call", surface: "discord",
      workspaceId: "guild", channelId: "voice", author: { externalId: "owner", isBot: false },
      addressees: [{ externalId: "BOT" }], dm: false, payload: state, render: "joined voice channel voice",
    });
    expect(discordCall({ ...state, channel_id: null }, 43, "gateway-session", "BOT")).toBeNull();
    expect(discordCall({ ...state, user_id: "BOT" }, 44, "gateway-session", "BOT")).toBeNull();
    expect(discordCall({ ...state, guild_id: undefined }, 45, "gateway-session", "BOT")).toBeNull();
  });
  it("normalizes a component tap with the matching button label", () => {
    const payload = {
      id: "interaction-1", token: "token", type: 3 as const, channel_id: "c",
      guild_id: "g", member: { user: { id: "u", username: "user" } },
      data: { custom_id: "approve" },
      message: { id: "m", components: [{ components: [{ custom_id: "approve", label: "Approve" }] }] },
    };
    expect(normalizer.normalize(payload)?.facts).toMatchObject({
      event: "postback", eventId: "interaction-1", render: "Approve",
      postback: { id: "approve", label: "Approve", messageRef: "m" },
      addressees: [{ externalId: "BOT" }], channelId: "c", dm: false, payload,
    });
    expect(normalizer.normalize({ ...payload, message: { id: "m" } })?.facts.render).toBe("approve");
  });
  it("reports bot authors from the interaction member or user", () => {
    const tap = {
      id: "tap", token: "token", type: 3 as const, channel_id: "c",
      data: { custom_id: "approve" },
    };
    expect(normalizer.normalize({
      ...tap, member: { user: { id: "member", username: "bot", bot: true } },
    })?.facts.author).toEqual({ externalId: "member", isBot: true });
    expect(normalizer.normalize({
      ...tap, user: { id: "user", username: "bot", bot: true },
    })?.facts.author).toEqual({ externalId: "user", isBot: true });
  });
  it("carries bot authors", () => {
    expect(
      normalizer.normalize({ ...message, author: { ...message.author, bot: true } })?.facts,
    ).toMatchObject({ event: "message", author: { externalId: "u", isBot: true } });
  });
  it("uses the target, emoji and sender for reaction identity", () => {
    expect(
      normalizer.normalize({
        message_id: "m",
        channel_id: "c",
        user_id: "u",
        emoji: { name: "wave" },
      })?.facts,
    ).toMatchObject({ eventId: "m:wave:u", event: "reaction", render: "wave" });
  });
  it("drops the bot's own echo", () => {
    expect(normalizer.normalize({ ...message, author: { id: "BOT", username: "bot" } })).toBeNull();
  });
  it("marks addressed messages", () => {
    expect(
      normalizer.normalize({ ...message, mentions: [{ id: "BOT", username: "bot" }] })?.facts,
    ).toMatchObject({ event: "mention", addressees: [{ externalId: "BOT" }] });
  });
});
