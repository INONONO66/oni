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
