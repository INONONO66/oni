import { describe, expect, it } from "bun:test";
import { DiscordNormalizer } from "../src/provider/discord/normalizer";

const normalizer = new DiscordNormalizer("BOT");
const message = {
  id: "m",
  channel_id: "c",
  author: { id: "u", username: "user" },
  content: "hello",
};

describe("Discord ingress facts", () => {
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
