import { describe, expect, it } from "bun:test";
import { Operational, Outbound } from "@oni/protocol";
import { TelegramBotError } from "../src/provider/telegram/sdk";
import { TelegramAdapter } from "../src/provider/telegram/surface";
import { injectedOptions } from "./helpers/injected";
import { fakeTelegramSdk } from "./helpers/telegram-sdk";

describe("Telegram markdown delivery", () => {
  it("preserves thread and reply parameters on the markdown request", async () => {
    const fake = fakeTelegramSdk();
    const adapter = new TelegramAdapter("token", {}, () => undefined, injectedOptions(), fake.sdk);
    await adapter.deliver("34", Outbound.payload("a.b"), "markdown-1", {
      channelId: "34",
      threadId: "99",
      replyToMessageId: "11",
    });
    expect(fake.client.calls[0]?.options).toEqual({
      text: "a\\.b",
      parse_mode: "MarkdownV2",
      reply_to_message_id: 11,
      message_thread_id: 99,
    });
  });

  it("falls back to plain text after an entity parse refusal", async () => {
    let warnings = 0;
    const fake = fakeTelegramSdk();
    fake.client.fail("sendMessage", new TelegramBotError("can't parse entities", "api_error", { httpStatus: 400 }));
    const adapter = new TelegramAdapter(
      "token",
      {},
      (event) => {
        if (event.name === Operational.Events.Warn.name)
          warnings += 1;
      },
      injectedOptions(),
      fake.sdk,
    );
    const conversation = { channelId: "chat-1", threadId: "55", replyToMessageId: "77" };
    expect(await adapter.deliver("chat-1", Outbound.payload("*broken"), "markdown-2", conversation)).toMatchObject({
      value: "sent",
    });
    expect(fake.client.calls).toEqual([
      { method: "sendMessage", chatId: "chat-1", options: {
        text: "\\*broken", parse_mode: "MarkdownV2", message_thread_id: 55, reply_to_message_id: 77,
      } },
      { method: "sendMessage", chatId: "chat-1", options: {
        text: "\\*broken", message_thread_id: 55, reply_to_message_id: 77,
      } },
    ]);
    expect(warnings).toBe(1);
  });

  it("does not resend a non-parse rejection", async () => {
    const fake = fakeTelegramSdk();
    fake.client.fail("sendMessage", new TelegramBotError("forbidden", "api_error", { httpStatus: 403 }));
    const adapter = new TelegramAdapter("token", {}, () => undefined, injectedOptions(), fake.sdk);
    expect(await adapter.deliver("chat-1", Outbound.payload("text"), "markdown-3")).toMatchObject({
      value: "not_sent",
    });
    expect(fake.client.calls).toHaveLength(1);
  });
});
