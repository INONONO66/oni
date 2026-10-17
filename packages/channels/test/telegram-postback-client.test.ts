import { expect, test } from "bun:test";
import { TelegramAdapter } from "../src/provider/telegram/surface";
import { injectedOptions } from "./helpers/injected";
import { fakeTelegramSdk } from "./helpers/telegram-sdk";

test("TelegramAdapter acknowledges a callback query through the SDK client", async () => {
  const fake = fakeTelegramSdk();
  const adapter = new TelegramAdapter("token", {}, () => undefined, injectedOptions(), fake.sdk);
  adapter.onMessage(async () => undefined);
  await adapter.start("boot");
  fake.listener.update({
    update_id: 1,
    callback_query: {
      id: "callback-1",
      from: { id: 7, is_bot: false, first_name: "User" },
      data: "approve",
      message: {
        message_id: 2,
        date: 1,
        chat: { id: 3, type: "private", first_name: "User" },
        from: { id: 42, is_bot: true, first_name: "Omni" },
        text: "Approve?",
        reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: "approve" }]] },
      },
    },
  });
  await Promise.resolve();
  expect(fake.client.calls.map(({ method }) => method)).toContain("answerCallbackQuery");
});
