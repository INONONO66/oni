import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { FIXED_NOW, testRun } from "./helpers/injected";
import { TelegramClient } from "../src/provider/telegram/client";

type JsonValue = z.infer<ReturnType<typeof z.json>>;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("TelegramClient acknowledges a callback query through answerCallbackQuery", async () => {
  const requests: { path: string; method: string | undefined; body: JsonValue }[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        path: String(input),
        method: init?.method,
        body: z.json().parse(JSON.parse(String(init?.body))),
      });
      return Response.json({ ok: true, result: true });
    },
    { preconnect: realFetch.preconnect },
  );
  const client = new TelegramClient(
    "token",
    () => undefined,
    () => FIXED_NOW,
    testRun,
  );

  await client.answerCallbackQuery("callback-1", "trace-ack");

  expect(requests).toEqual([
    {
      path: "https://api.telegram.org/bottoken/answerCallbackQuery",
      method: "POST",
      body: { callback_query_id: "callback-1" },
    },
  ]);
});
