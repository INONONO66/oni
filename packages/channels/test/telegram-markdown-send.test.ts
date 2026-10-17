import { describe, expect, it } from "bun:test";
import { Operational, Outbound } from "@openomni/protocol";
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
    const warnings: string[] = [];
    const fake = fakeTelegramSdk();
    fake.client.fail("sendMessage", new TelegramBotError("can't parse entities", "api_error", { httpStatus: 400 }));
    const adapter = new TelegramAdapter(
      "token",
      {},
      (event, data) => {
        if (event.name === Operational.Events.Warn.name)
          warnings.push(Operational.Events.Warn.schema.parse(data).msg);
      },
      injectedOptions(),
      fake.sdk,
    );
    expect(await adapter.deliver("chat-1", Outbound.payload("*broken"), "markdown-2")).toMatchObject({
      value: "sent",
    });
    expect(warnings).toContain("telegram markdown rejected — delivered as plain text");
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
