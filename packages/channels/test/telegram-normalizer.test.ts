import { describe, expect, it } from "bun:test";
import { TelegramNormalizer } from "../src/provider/telegram/normalizer";

const normalizer = new TelegramNormalizer({ botId: "99", botUsername: "omni_bot" });
const message = {
  message_id: 7,
  date: 0,
  chat: { id: 5, type: "group" as const },
  from: { id: 3, is_bot: false, first_name: "Alice" },
  text: "hello",
};

describe("Telegram ingress facts", () => {
  it("normalizes a callback with the keyboard label and message reference", () => {
    const payload = {
      id: "callback-1", from: message.from, data: "approve",
      message: {
        ...message, chat: { id: 5, type: "private" as const },
        reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: "approve" }]] },
      },
    };
    expect(normalizer.normalize(payload)?.facts).toMatchObject({
      event: "postback", eventId: "callback-1", render: "Approve",
      postback: { id: "approve", label: "Approve", messageRef: "7" },
      addressees: [{ externalId: "99" }], channelId: "5", dm: true, payload,
    });
    expect(normalizer.normalize({ ...payload, message: message })?.facts.render).toBe("approve");
  });
  it("carries bot authors", () => {
    expect(
      normalizer.normalize({ ...message, from: { ...message.from, is_bot: true } })?.facts,
    ).toMatchObject({ event: "message", author: { externalId: "3", isBot: true } });
  });
  it("normalizes reactions with a stable event identity", () => {
    expect(
      normalizer.normalize({
        chat: message.chat,
        message_id: 7,
        date: 0,
        user: message.from,
        new_reaction: [{ type: "emoji", emoji: "heart" }],
      })?.facts,
    ).toMatchObject({ event: "reaction", eventId: "7:heart:3", render: "heart" });
  });
  it("drops the bot's own echo", () => {
    expect(normalizer.normalize({ ...message, from: { ...message.from, id: 99 } })).toBeNull();
  });
  it("marks username and text mentions", () => {
    const username = "@omni_bot";
    expect(
      normalizer.normalize({
        ...message,
        text: username,
        entities: [{ type: "mention", offset: 0, length: username.length }],
      })?.facts,
    ).toMatchObject({ event: "mention", addressees: [{ externalId: "99" }] });
    expect(
      normalizer.normalize({
        ...message,
        entities: [
          { type: "text_mention", offset: 0, length: 5, user: { ...message.from, id: 99 } },
        ],
      })?.facts.event,
    ).toBe("mention");
  });
});
