import { afterEach, describe, expect, it } from "bun:test";
import { FIXED_NOW, testRun } from "./helpers/injected";
import { TelegramClient } from "../src/provider/telegram/client";

type SentBody = {
  text?: string;
  parse_mode?: string;
  chat_id?: string;
  reply_to_message_id?: number;
  message_thread_id?: number;
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockSendMessage(respond: (body: SentBody, call: number) => Response): {
  calls: SentBody[];
} {
  const calls: SentBody[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toContain("/sendMessage");
    const body = JSON.parse(String(init?.body)) as SentBody;
    calls.push(body);
    return respond(body, calls.length);
  }) as typeof fetch;
  return { calls };
}

function okResponse(): Response {
  return Response.json({ ok: true, result: { message_id: 42 } });
}

function parseRejection(): Response {
  return Response.json(
    {
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse entities: Character '.' is reserved",
    },
    { status: 400 },
  );
}

describe("TelegramClient.sendMarkdown", () => {
  it("quotes the answered message and posts into its topic, on the fallback too (#1490)", async () => {
    const { calls } = mockSendMessage((body) =>
      body.parse_mode === undefined ? okResponse() : parseRejection(),
    );
    const client = new TelegramClient("token", () => undefined, () => FIXED_NOW, testRun);

    const id = await client.sendMarkdown("34", "a.b", "trace-3", {
      channelId: "34",
      threadId: "99",
      replyToMessageId: "11",
    });

    expect(id).toBe("42");
    expect(calls.map(({ parse_mode, reply_to_message_id, message_thread_id }) => ({
      parse_mode,
      reply_to_message_id,
      message_thread_id,
    }))).toEqual([
      { parse_mode: "MarkdownV2", reply_to_message_id: 11, message_thread_id: 99 },
      { parse_mode: undefined, reply_to_message_id: 11, message_thread_id: 99 },
    ]);
  });

  it("sends with MarkdownV2 parse mode and returns the message id", async () => {
    const { calls } = mockSendMessage(() => okResponse());
    const client = new TelegramClient("token", () => undefined, () => FIXED_NOW, testRun);

    const id = await client.sendMarkdown("chat-1", "*bold*", "trace-1");

    expect(id).toBe("42");
    expect(calls).toEqual([
      { chat_id: "chat-1", text: "*bold*", parse_mode: "MarkdownV2" } as SentBody,
    ]);
  });

  it("resends the same text as plain on an entity-parse rejection and warns", async () => {
    const { calls } = mockSendMessage((body) =>
      body.parse_mode === undefined ? okResponse() : parseRejection(),
    );
    const warnings: string[] = [];
    const client = new TelegramClient("token", (_, event) => {
      warnings.push((event as { msg: string }).msg);
    }, () => FIXED_NOW, testRun);

    const id = await client.sendMarkdown("chat-1", "*broken", "trace-1");

    expect(id).toBe("42");
    expect(calls.map((call) => call.parse_mode)).toEqual(["MarkdownV2", undefined]);
    expect(calls.map((call) => call.text)).toEqual(["*broken", "*broken"]);
    expect(warnings).toContain("telegram markdown rejected — delivered as plain text");
  });

  it("rethrows non-parse failures without a plain resend", async () => {
    const { calls } = mockSendMessage(() => new Response("forbidden", { status: 403 }));
    const client = new TelegramClient("token", () => undefined, () => FIXED_NOW, testRun);

    await expect(client.sendMarkdown("chat-1", "text", "trace-1")).rejects.toThrow(
      "Telegram API sendMessage failed (403)",
    );
    expect(calls).toHaveLength(1);
  });

  it("send keeps the plain path free of parse mode", async () => {
    const { calls } = mockSendMessage(() => okResponse());
    const client = new TelegramClient("token", () => undefined, () => FIXED_NOW, testRun);

    const id = await client.send("chat-1", "hello", "trace-1");

    expect(id).toBe("42");
    expect(calls[0]?.parse_mode).toBeUndefined();
  });
});
