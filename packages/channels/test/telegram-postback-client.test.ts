import { afterEach, expect, test } from "bun:test";
import { FIXED_NOW, testRun } from "./helpers/injected";
import { TelegramClient } from "../src/provider/telegram/client";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("TelegramClient acknowledges a callback and subscribes to callback updates", async () => {
  const requests: { path: string; method: string | undefined; body: unknown }[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      requests.push({ path, method: init?.method, body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, result: path.endsWith("/getUpdates") ? [] : true });
    },
    { preconnect: realFetch.preconnect },
  );
  const client = new TelegramClient("token", () => undefined, () => FIXED_NOW, testRun);

  await client.answerCallbackQuery("callback-1", "trace-ack");
  expect(await client.getUpdates(4, "trace-poll")).toEqual([]);

  expect(requests).toEqual([
    {
      path: "https://api.telegram.org/bottoken/answerCallbackQuery",
      method: "POST",
      body: { callback_query_id: "callback-1" },
    },
    {
      path: "https://api.telegram.org/bottoken/getUpdates",
      method: "POST",
      body: {
        offset: 4, timeout: 30,
        allowed_updates: ["message", "message_reaction", "callback_query"],
      },
    },
  ]);
});
