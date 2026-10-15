import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { TelegramClient } from "../src/provider/telegram/client";
import { testRun } from "./helpers/injected";

const SentBody = z.object({
  chat_id: z.string(),
  text: z.string(),
  parse_mode: z.string().optional(),
  reply_to_message_id: z.number().optional(),
  message_thread_id: z.number().optional(),
});
type SentBody = z.infer<typeof SentBody>;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function capture(respond: (body: SentBody) => Response): SentBody[] {
  const calls: SentBody[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toContain("/sendMessage");
    const body = SentBody.parse(JSON.parse(String(init?.body)));
    calls.push(body);
    return respond(body);
  }, { preconnect: realFetch.preconnect });
  return calls;
}

describe("TelegramClient HTML sends", () => {
  it("preserves the answered message and topic when posting HTML", async () => {
    const calls = capture(() => Response.json({ ok: true, result: { message_id: 42 } }));
    const client = new TelegramClient("token", () => undefined, testRun);
    expect(await client.sendHtml("34", "<b>hello</b>", "trace-3", {
      channelId: "34", threadId: "99", replyToMessageId: "11",
    })).toBe("42");
    expect(calls).toEqual([{
      chat_id: "34", text: "<b>hello</b>", parse_mode: "HTML",
      reply_to_message_id: 11, message_thread_id: 99,
    }]);
  });

  it("does not resend a rejected HTML entity as plain text", async () => {
    const calls = capture(() => Response.json({
      ok: false, description: "Bad Request: can't parse entities",
    }, { status: 400 }));
    const client = new TelegramClient("token", () => undefined, testRun);
    await expect(client.sendHtml("chat-1", "<b>broken", "trace-1")).rejects.toThrow(
      "Telegram API sendMessage failed (400)",
    );
    expect(calls).toHaveLength(1);
  });

  it("propagates forbidden without a second send", async () => {
    const calls = capture(() => new Response("forbidden", { status: 403 }));
    const client = new TelegramClient("token", () => undefined, testRun);
    await expect(client.sendHtml("chat-1", "<b>text</b>", "trace-1")).rejects.toThrow(
      "Telegram API sendMessage failed (403)",
    );
    expect(calls).toHaveLength(1);
  });

  it("keeps the plain client send free of parse mode", async () => {
    const calls = capture(() => Response.json({ ok: true, result: { message_id: 42 } }));
    const client = new TelegramClient("token", () => undefined, testRun);
    expect(await client.send("chat-1", "hello", "trace-1")).toBe("42");
    expect(calls).toEqual([{ chat_id: "chat-1", text: "hello" }]);
  });
});
