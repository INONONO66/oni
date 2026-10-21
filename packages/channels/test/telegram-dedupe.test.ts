import { afterEach, describe, expect, test } from "bun:test";
import { FIXED_NOW, injectedOptions } from "./helpers/injected";
import { Outbound } from "@oni/protocol";
import { DiscordAdapter } from "../src/provider/discord/surface";
import { TelegramAdapter } from "../src/provider/telegram/surface";
import { Dedupe } from "../src/support/dedupe";
import { DeliveryReconciliation, type DeliveryReceipt } from "../src/support/deliver";

/**
 * Outbound dedupe over the delivery reconciliation: a stale claim released
 * after its replacement must not drop the replacement's receipt. The inbound
 * D1 case (per-chat message_id, dedupe keyed on `${chat.id}:${message_id}`)
 * rides the SDK listener fake in telegram-surface.test.ts (#1569).
 */

const realFetch = globalThis.fetch;

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

    const receipt = await owner.deliver(
      "recipient-1",
      Outbound.payload("a".repeat(2001)),
      "chunked-message",
    );

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
