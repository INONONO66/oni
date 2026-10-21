import { describe, expect, it } from "bun:test";
import { DiscordNormalizer } from "../src/provider/discord/normalizer";
import { TelegramNormalizer } from "../src/provider/telegram/normalizer";
import { telegramReply } from "./helpers/telegram";

describe("channel normalizers", () => {
  it("maps Discord messages into ingress facts", () => {
    const message = new DiscordNormalizer().normalize({
      id: "discord-in-1",
      channel_id: "dev",
      guild_id: "guild-1",
      author: { id: "seller-1", username: "Seller" },
      content: "tracking number",
      message_reference: { message_id: "discord-out-1" },
    });

    expect(message).toMatchObject({
      sender: { kind: "external", surface: "discord", externalId: "seller-1" },
      facts: {
        eventId: "discord-in-1",
        surface: "discord",
        channelId: "dev",
        dm: false,
        reply: { chain: ["discord-out-1"] },
        render: "tracking number",
      },
    });
  });

  it("maps Telegram replies into ingress facts", () => {
    const message = new TelegramNormalizer({
      botId: "bot-1",
      botUsername: "oni_bot",
    }).normalize(telegramReply());

    expect(message?.facts.payload).not.toHaveProperty("from.username");
    expect(message).toMatchObject({
      sender: { kind: "external", surface: "telegram", externalId: "56" },
      facts: {
        eventId: "12",
        surface: "telegram",
        channelId: "34",
        dm: false,
        reply: { chain: ["11"] },
        render: "tracking number",
      },
    });
  });
});
