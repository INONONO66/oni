import { describe, expect, test } from "bun:test";
import { DiscordNormalizer } from "../src/provider/discord/normalizer";
import { SlackNormalizer } from "../src/provider/slack/normalizer";
import { TelegramNormalizer } from "../src/provider/telegram/normalizer";
import { accountInbound } from "../src/provider/telegram/account-normalizer.js";
import { accountMessage } from "./helpers/telegram-account-sdk.js";
import { telegramReply } from "./helpers/telegram";

describe("provider ingress facts", () => {
  test("Telegram Account preserves account-local ids and caption, mention and native reply", () => {
    const result = accountInbound({
      ...accountMessage, dm: false, mentionedUserIds: ["account-1"],
      media: [{ kind: "audio", fileId: 4, name: "voice.ogg", mime: "audio/ogg", size: 12, voice: true }],
    }, "account-1");
    expect(result?.facts).toMatchObject({
      eventId: "tdlib:100", event: "mention", channelId: "chat-1",
      addressees: [{ externalId: "account-1" }], render: "caption",
      reply: { chain: ["99"], replyToMessageId: "99" },
      attachments: [{ kind: "audio", ref: "tdlib-file:4", voice: true }],
      });
  });
  test("telegram preserves event identity, author, reply chain, and render text", () => {
    const result = new TelegramNormalizer({
      botId: "bot-1",
      botUsername: "oni_bot",
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
      author: { id: "account-1", username: "Account" },
      content: "status?",
    });
    expect(result?.facts).toMatchObject({
      eventId: "discord-dm-1",
      event: "message",
      author: { externalId: "account-1", isBot: false },
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
      parent_user_id: "UBOT",
    });
    expect(result?.facts).toMatchObject({
      eventId: "1710.0002",
      event: "mention",
      author: { externalId: "T9:U77", isBot: false },
      workspaceId: "T9",
      channelId: "C123",
      addressees: [{ externalId: "T9:UBOT" }],
      account: "T9:UBOT",
      quotes: "T9:UBOT",
      dm: false,
      reply: { chain: ["1710.0001"] },
      render: "<@UBOT> tracking number",
    });
    expect(result?.sender.externalId).toBe("T9:U77");
  });

  test.each([false, true])("normalizers preserve bot=%s independently of addressing", (isBot) => {
    const slack = new SlackNormalizer({ botUserId: "self", team: "T" }).normalize({
      type: "message", channel: "D1", channel_type: "im", user: "peer", ts: "1",
      text: "<@self> <@other>", ...(isBot ? { bot_id: "integration" } : {}),
      parent_user_id: "quoted",
    });
    expect(slack?.facts).toMatchObject({
      account: "T:self", addressees: [{ externalId: "T:self" }, { externalId: "T:other" }],
      dm: true, author: { externalId: "T:peer", isBot }, quotes: "T:quoted",
    });
    const discord = new DiscordNormalizer("self").normalize({
      id: "1", channel_id: "D1", author: { id: "peer", username: "Peer", bot: isBot },
      content: "<@self>", mentions: [{ id: "self", username: "Self" }],
      referenced_message: { author: { id: "quoted", username: "Quoted" } },
    });
    expect(discord?.facts).toMatchObject({
      account: "self", addressees: [{ externalId: "self" }],
      dm: true, author: { externalId: "peer", isBot }, quotes: "quoted",
    });
    const telegram = new TelegramNormalizer({ botId: "1", botUsername: "self" }).normalize({
      ...telegramReply("peer"), from: { id: 56, first_name: "Peer", is_bot: isBot },
      text: "@self", entities: [{ type: "mention", offset: 0, length: 5 }],
      chat: { id: 34, type: "private" },
    });
    expect(telegram?.facts).toMatchObject({
      account: "1", addressees: [{ externalId: "1" }],
      dm: true, author: { externalId: "56", isBot }, quotes: "78",
    });
    const account = accountInbound({
      ...accountMessage, sender: { kind: "user", id: "peer", isBot },
      mentionedUserIds: ["account-1", "other"], dm: false,
    }, "account-1");
    expect(account?.facts).toMatchObject({
      account: "account-1", addressees: [{ externalId: "account-1" }, { externalId: "other" }],
      dm: false, author: { externalId: "peer", isBot },
    });
    // The account transport supplies a reply id, but no quoted author.
    expect(account?.facts.quotes).toBeUndefined();
  });

  test("a slack mention at channel top level keys the thread its answer opens on its own ts (#1490)", () => {
    const normalizer = new SlackNormalizer({ botUserId: "UBOT", team: "T9" });
    const event = { type: "message", channel: "C123", channel_type: "channel", user: "U77", ts: "1710.0005" };
    expect(normalizer.normalize({ ...event, text: "<@UBOT> status?" })?.facts.reply).toEqual({
      chain: [],
      threadId: "1710.0005",
    });
    expect(normalizer.normalize({ ...event, text: "no bot here" })?.facts.reply).toBeUndefined();
    expect(
      normalizer.normalize({ ...event, channel: "D1", channel_type: "im", text: "<@UBOT> dm" })?.facts.reply,
    ).toBeUndefined();
  });

  test("a telegram forum topic is the thread and a quoted message the reply-to; a bare group message has neither (#1490)", () => {
    const normalizer = new TelegramNormalizer({ botId: "bot-1", botUsername: "oni_bot" });
    const topic = telegramReply("seller_acct");
    expect(
      normalizer.normalize({ ...topic, is_topic_message: true, message_thread_id: 99 })?.facts.reply,
    ).toEqual({ chain: ["11"], threadId: "99", replyToMessageId: "11" });
    const { reply_to_message: _quoted, ...bare } = topic;
    expect(normalizer.normalize(bare)?.facts.reply).toBeUndefined();
    expect(normalizer.normalize(bare)?.facts.context).toBeUndefined();
  });

  test("a telegram quoted message is carried as context, the bot's own as assistant (#1490)", () => {
    const normalizer = new TelegramNormalizer({ botId: "78", botUsername: "oni_bot" });
    const quoted = telegramReply("seller_acct");
    expect(normalizer.normalize(quoted)?.facts.context).toEqual({ quoted: { author: "assistant", text: "please report" } });
    const human = { ...quoted, reply_to_message: { ...quoted.reply_to_message, from: { id: 90, is_bot: false, first_name: "Kim" } } };
    expect(normalizer.normalize(human as typeof quoted)?.facts.context).toEqual({ quoted: { author: "Kim", text: "please report" } });
  });
});
