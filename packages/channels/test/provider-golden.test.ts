import { describe, expect, test } from "bun:test";
import { DiscordNormalizer } from "../src/provider/discord/normalizer";
import { SlackNormalizer } from "../src/provider/slack/normalizer";
import { TelegramNormalizer } from "../src/provider/telegram/normalizer";
import { telegramReply } from "./helpers/telegram";

describe("provider ingress facts", () => {
  test("telegram preserves event identity, author, reply chain, and render text", () => {
    const result = new TelegramNormalizer({
      botId: "bot-1",
      botUsername: "openomni_bot",
    }).normalize(telegramReply("seller_acct"));
    expect(result?.facts).toMatchObject({
      eventId: "12",
      event: "message",
      author: { externalId: "56", isBot: false },
      channelId: "34",
      reply: { chain: ["11"] },
      render: "tracking number",
    });
    expect(result?.sender.externalId).toBe("56");
    expect(result?.facts.payload).toMatchObject({ from: { username: "seller_acct" } });
  });

  test("discord preserves DM identity, author and content", () => {
    const result = new DiscordNormalizer().normalize({
      id: "discord-dm-1",
      channel_id: "dm-chan",
      author: { id: "owner-1", username: "Owner" },
      content: "status?",
    });
    expect(result?.facts).toMatchObject({
      eventId: "discord-dm-1",
      event: "message",
      author: { externalId: "owner-1", isBot: false },
      channelId: "dm-chan",
      dm: true,
      render: "status?",
    });
  });

  test("slack carries workspace, thread, author, and mention facts", () => {
    const result = new SlackNormalizer({ botUserId: "UBOT", team: "T9" }).normalize({
      type: "message",
      channel: "C123",
      channel_type: "channel",
      user: "U77",
      text: "<@UBOT> tracking number",
      ts: "1710.0002",
      thread_ts: "1710.0001",
    });
    expect(result?.facts).toMatchObject({
      eventId: "1710.0002",
      event: "mention",
      author: { externalId: "T9:U77", isBot: false },
      workspaceId: "T9",
      channelId: "C123",
      addressees: [{ externalId: "T9:UBOT" }],
      reply: { chain: ["1710.0001"] },
      render: "<@UBOT> tracking number",
    });
    expect(result?.sender.externalId).toBe("T9:U77");
  });
});
