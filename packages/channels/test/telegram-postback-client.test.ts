import { expect, test } from "bun:test";
import { TelegramAdapter } from "../src/provider/telegram/surface";
import { injectedOptions } from "./helpers/injected";
import { FakeTelegramListener } from "./helpers/telegram-sdk";
import { telegramSdk } from "../src/provider/telegram/sdk";
import { recordHttp } from "./helpers/http";
import { bounded } from "./helpers/bounded";

test("TelegramAdapter acknowledges a callback query through the SDK client", async () => {
  const listener = new FakeTelegramListener();
  const entered = Promise.withResolvers<void>();
  const ack = Promise.withResolvers<Response>();
  const handled = Promise.withResolvers<void>();
  let handoffs = 0;
  const wire = recordHttp(() => { entered.resolve(); return ack.promise; });
  const adapter = new TelegramAdapter("token", {}, () => undefined, injectedOptions(), {
    ...telegramSdk(), listener: () => listener,
  });
  adapter.onMessage(async () => { handoffs++; handled.resolve(); });
  try {
  await adapter.start("boot");
  listener.update({
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
  await bounded(entered.promise);
  expect(handoffs).toBe(0);
  expect(wire.requests).toHaveLength(1);
  expect(wire.requests[0]?.url).toEndWith("/answerCallbackQuery");
  expect(await wire.requests[0]?.json()).toEqual({ callback_query_id: "callback-1" });
  ack.resolve(Response.json({ ok: true, result: true }));
  await bounded(handled.promise);
  expect(handoffs).toBe(1);
  } finally {
    ack.resolve(Response.json({ ok: true, result: true }));
    adapter.stop("stop");
    wire.restore();
  }
});
