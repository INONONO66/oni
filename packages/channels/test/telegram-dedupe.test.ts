import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { FIXED_NOW, injectedOptions } from "./helpers/injected";
import { type Channel, Outbound, type PlainValue } from "@openomni/protocol";
import type { TelegramMessage } from "../src/provider/telegram/types";
import { DiscordAdapter } from "../src/provider/discord/surface";
import { TelegramAdapter } from "../src/provider/telegram/surface";
import { Dedupe } from "../src/support/dedupe";
import { DeliveryReconciliation, type DeliveryReceipt } from "../src/support/deliver";

/**
 * D1: telegram message_id is a PER-CHAT counter, so two different chats can
 * legitimately share one id inside the dedupe window. The surface must key
 * dedupe on `${chat.id}:${message_id}` — keying on the bare message_id
 * silently dropped the second chat's message with no trace.
 */

const realFetch = globalThis.fetch;

function jsonResponse(result: PlainValue): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function tgMessage(messageId: number, chatId: number, text: string) {
  return {
    message_id: messageId,
    chat: { id: chatId, type: "private" },
    from: { id: chatId, is_bot: false, first_name: `u${chatId}`, username: `u${chatId}` },
    date: 1_700_000_000,
    text,
  } satisfies TelegramMessage;
}

describe("TelegramAdapter dedupe (D1)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    let getUpdatesCall = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return jsonResponse({ id: 42, is_bot: true, username: "bot", first_name: "Bot" });
      }
      if (url.endsWith("/getUpdates")) {
        getUpdatesCall += 1;
        if (getUpdatesCall === 1) {
          // Same message_id (100) across two distinct chats within the window.
          return jsonResponse([
            { update_id: 1, message: tgMessage(100, 111, "hello from chat one") },
            { update_id: 2, message: tgMessage(100, 222, "hello from chat two") },
          ]);
        }
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      // sendChatAction / sendMessage / anything else
      return jsonResponse(true);
    }) as typeof fetch;
  });

  it("delivers same message_id from two different chats (no cross-chat collision)", async () => {
    const delivered: Channel.InboundMessage[] = [];
    const deliveredBoth = Promise.withResolvers<void>();
    const adapter = new TelegramAdapter("test-token", {}, () => undefined, injectedOptions());
    adapter.onMessage(async (message) => {
      delivered.push(message);
      if (delivered.length === 2) deliveredBoth.resolve();
      return undefined;
    });

    const timeout = setTimeout(
      () => deliveredBoth.reject(new Error("Telegram handoff timed out")),
      2_000,
    );
    try {
      await adapter.start("trace-dedupe-test");
      await deliveredBoth.promise;
    } finally {
      clearTimeout(timeout);
      adapter.stop("trace-dedupe-test");
    }

    expect(delivered).toHaveLength(2);
    const surfaceKeys = delivered.map((m) => m.facts.channelId).sort();
    expect(new Set(surfaceKeys).size).toBe(2);
    expect(surfaceKeys.some((k) => k.includes("111"))).toBe(true);
    expect(surfaceKeys.some((k) => k.includes("222"))).toBe(true);
  });
});

function expectStaleReleasePreservesReplacement(
  dedupe: Dedupe,
  first: ReturnType<Dedupe["acquire"]>,
) {
  const second = dedupe.acquire("same-id");
  expect(second.duplicate).toBe(false);
  if (first.duplicate) throw new Error("first acquisition was not accepted");
  dedupe.forget("same-id", first.token);
  expect(dedupe.acquire("same-id").duplicate).toBe(true);
}

const config = {};
type DeliveryOwner = Readonly<{
  deliver(
    externalId: string,
    payload: Outbound.Payload,
    idempotencyKey: string,
  ): Promise<{
    value: "sent" | "not_sent" | "unknown";
    externalMessageId?: string;
  }>;
}>;

function telegramFixture(): { owner: DeliveryOwner; outboundCalls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (!String(input).endsWith("/sendMessage")) throw new Error(`unexpected request: ${input}`);
    calls += 1;
    return Response.json({ ok: true, result: { message_id: calls } });
  }) as typeof fetch;
  return {
    owner: new TelegramAdapter("token", config, () => undefined, injectedOptions()),
    outboundCalls: () => calls,
  };
}

function discordFixture(): { owner: DeliveryOwner; outboundCalls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm-1" });
    if (url.endsWith("/channels/dm-1/messages")) {
      calls += 1;
      return Response.json({ id: `discord-message-${calls}` });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return {
    owner: new DiscordAdapter("token", config, () => undefined, injectedOptions()),
    outboundCalls: () => calls,
  };
}

const owners = [
  ["Telegram", telegramFixture],
  ["Discord", discordFixture],
] as const;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("outbound adapter delivery dedupe capability", () => {
  test.each(
    owners,
  )("%s reuses one outbound result when an idempotency key is supplied", async (_name, fixture) => {
    const { owner, outboundCalls } = fixture();

    const [first, retry] = await Promise.all([
      owner.deliver("recipient-1", Outbound.payload("hello"), "gateway-message-1"),
      owner.deliver("recipient-1", Outbound.payload("hello"), "gateway-message-1"),
    ]);

    expect(outboundCalls()).toBe(1);
    expect(retry).toEqual(first);
  });

  test.each(
    owners,
  )("%s delivers independently for distinct idempotency keys", async (_name, fixture) => {
    const { owner, outboundCalls } = fixture();

    await owner.deliver("recipient-1", Outbound.payload("hello"), "gateway-message-2");
    await owner.deliver("recipient-1", Outbound.payload("hello"), "gateway-message-3");
    expect(outboundCalls()).toBe(2);
  });

  test("Discord returns the final chunk id as the reply correlation", async () => {
    const { owner, outboundCalls } = discordFixture();

    const receipt = await owner.deliver("recipient-1", Outbound.payload("a".repeat(2001)), "chunked-message");

    expect(outboundCalls()).toBe(2);
    expect(receipt).toEqual({ value: "sent", externalMessageId: "discord-message-2" });
  });

  test("only a proven not-sent delivery releases custody for retry", async () => {
    const reconciliation = new DeliveryReconciliation();
    let attempts = 0;
    const operation = async (): Promise<DeliveryReceipt> => {
      attempts += 1;
      return { value: attempts === 1 ? "not_sent" : "sent" };
    };

    expect(await reconciliation.run("message-1", operation)).toEqual({ value: "not_sent" });
    expect(await reconciliation.run("message-1", operation)).toEqual({ value: "sent" });
    expect(attempts).toBe(2);
  });

  test("the inbound dedupe bound evicts oldest ids rather than dropping new work", () => {
    const dedupe = new Dedupe(() => FIXED_NOW, Number.POSITIVE_INFINITY, 2);
    for (let index = 0; index < 100; index += 1) {
      expect(dedupe.acquire(`message-${index}`).duplicate).toBe(false);
    }

    expect(dedupe.acquire("message-0").duplicate).toBe(false);
    expect(dedupe.acquire("message-99").duplicate).toBe(true);
  });

  test("a stale release cannot remove a newer generation after expiry", () => {
    let now = 1_000;
    const dedupe = new Dedupe(() => now, 5);
    const first = dedupe.acquire("same-id");
    now += 6;
    expectStaleReleasePreservesReplacement(dedupe, first);
  });

  test("a stale release cannot remove a newer generation after capacity eviction", () => {
    const dedupe = new Dedupe(() => FIXED_NOW, Number.POSITIVE_INFINITY, 1);
    const first = dedupe.acquire("same-id");
    for (let index = 0; index < 99; index += 1) dedupe.acquire(`other-${index}`);
    dedupe.acquire("eviction-trigger");
    expectStaleReleasePreservesReplacement(dedupe, first);
  });
});
