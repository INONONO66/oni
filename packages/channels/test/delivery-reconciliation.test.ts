import { expect, test } from "bun:test";
import { Outbound } from "@oni/protocol";
import { FIXED_NOW, injectedOptions, sequentialIds } from "./helpers/injected";
import { deliveryFixture, installDeliveryFetch } from "./helpers/delivery";
import { TelegramAdapter } from "../src/provider/telegram/surface";
import { GitHubAdapter } from "../src/provider/github/surface";
import { DeliveryReconciliation, deliverKeyed } from "../src/support/deliver";
import { bounded } from "./helpers/bounded";

// #1569: Slack rides the agent-messenger SDK; its physical evidence is pinned over the SDK error shapes in slack-surface.test.ts.
for (const provider of ["discord", "discord-owner", "telegram"] as const) {
  test(`${provider}: lost ACK never repeats a physical send at a non-deduplicating destination`, async () => {
    const arrived = Promise.withResolvers<void>();
    const ack = Promise.withResolvers<void>();
    let physicalSends = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        physicalSends++;
        arrived.resolve();
        return ack.promise.then(() =>
          Response.json({ id: "ack", ok: true, ts: "ack", result: { message_id: 1 } }),
        );
      },
    });
    const fetch = globalThis.fetch;
    const controller = new AbortController();
    const restore = installDeliveryFetch(() =>
      fetch(server.url, {
        method: "POST",
        body: "SENTINEL",
        signal: controller.signal,
      }),
    );
    try {
      const { adapter, address } = deliveryFixture(provider);
      const first = adapter.deliver(address, Outbound.payload("SENTINEL"), "lost-ack");
      const concurrent = adapter.deliver(address, Outbound.payload("SENTINEL"), "lost-ack");
      await bounded(arrived.promise);
      controller.abort();
      expect(await bounded(first)).toEqual({ value: "unknown" });
      expect(await bounded(concurrent)).toEqual({ value: "unknown" });
      expect(await adapter.deliver(address, Outbound.payload("SENTINEL"), "lost-ack")).toEqual({
        value: "unknown",
      });
      expect(physicalSends).toBe(1);
      // The destination does NOT suppress repeated content or delivery keys.
      ack.resolve();
      await fetch(server.url, { method: "POST", body: "SENTINEL" });
      expect(physicalSends).toBe(2);
    } finally {
      ack.resolve();
      restore();
      await server.stop(true);
    }
  });

  test(`${provider}: proof of no connection permits retry, sent then remains terminal`, async () => {
    let physicalSends = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        physicalSends++;
        return Response.json({ id: "ack", ok: true, ts: "ack", result: { message_id: "ack" } });
      },
    });
    const fetch = globalThis.fetch;
    let refuse = true;
    const restore = installDeliveryFetch(() => {
      if (refuse)
        throw Object.assign(new TypeError("connection unavailable"), { code: "ECONNREFUSED" });
      return fetch(server.url, { method: "POST" });
    });
    try {
      const { adapter, address } = deliveryFixture(provider);
      expect(await adapter.deliver(address, Outbound.payload("SENTINEL"), "retryable")).toEqual({
        value: "not_sent",
      });
      expect(physicalSends).toBe(0);
      refuse = false;
      expect(await adapter.deliver(address, Outbound.payload("SENTINEL"), "retryable")).toEqual({
        value: "sent",
        externalMessageId: "ack",
      });
      expect(await adapter.deliver(address, Outbound.payload("SENTINEL"), "retryable")).toEqual({
        value: "sent",
        externalMessageId: "ack",
      });
      expect(physicalSends).toBe(1);
    } finally {
      restore();
      await server.stop(true);
    }
  });
}

test("uncertain reconciliation custody does not expire with an inbound dedupe window", async () => {
  const reconciliation = new DeliveryReconciliation();
  let now = FIXED_NOW;
  let physicalSends = 0;
  const send = () =>
    deliverKeyed(
      reconciliation,
      "stable",
      async () => {
        physicalSends++;
        return { accepted: false };
      },
      () => false,
      () => undefined,
      { now: () => now, id: sequentialIds() },
    );
  expect(await send()).toEqual({ value: "unknown" });
  now += 24 * 60 * 60_000;
  expect(await send()).toEqual({ value: "unknown" });
  expect(physicalSends).toBe(1);
});

test("proven sends age out of custody in send order while uncertain keys stay forever", async () => {
  const reconciliation = new DeliveryReconciliation(2);
  const sends = new Map<string, number>();
  const send = (key: string, id: string | undefined) =>
    deliverKeyed(
      reconciliation,
      key,
      async () => {
        sends.set(key, (sends.get(key) ?? 0) + 1);
        return id === undefined ? { accepted: false } : { accepted: true, externalMessageId: id };
      },
      () => false,
      () => undefined,
      { now: () => FIXED_NOW, id: sequentialIds() },
    );
  await send("lost", undefined);
  await send("a", "1");
  await send("b", "2");
  // Within retention: proven keys are still remembered.
  await send("a", "1");
  await send("b", "2");
  expect(sends.get("a")).toBe(1);
  expect(sends.get("b")).toBe(1);
  // A third proven key evicts only the oldest proven key.
  await send("c", "3");
  await send("b", "2");
  await send("c", "3");
  await send("a", "1");
  await send("lost", undefined);
  expect(sends.get("a")).toBe(2);
  expect(sends.get("b")).toBe(1);
  expect(sends.get("c")).toBe(1);
  expect(sends.get("lost")).toBe(1);
});

test("GitHub uncertainty is terminal even when comment read-back would show no marker", async () => {
  let physicalSends = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method === "GET") return Response.json([]);
      physicalSends++;
      return new Response("lost response body");
    },
  });
  const fetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (_input: string | URL | Request, init?: RequestInit) => fetch(server.url, init),
    { preconnect: fetch.preconnect },
  );
  try {
    const adapter = new GitHubAdapter("secret", {}, () => undefined, injectedOptions(), "token");
    expect(await adapter.deliver("owner/repo#1", Outbound.payload("SENTINEL"), "key")).toEqual({
      value: "unknown",
    });
    expect(await adapter.deliver("owner/repo#1", Outbound.payload("SENTINEL"), "key")).toEqual({
      value: "unknown",
    });
    expect(physicalSends).toBe(1);
    await fetch(server.url, { method: "POST" });
    expect(physicalSends).toBe(2);
  } finally {
    globalThis.fetch = fetch;
    await server.stop(true);
  }
});

// #1569: Slack has no DM preflight on the SDK (it posts to the user id directly).
for (const provider of ["github", "discord", "discord-owner"] as const) {
  test(`${provider}: a failed preflight is not_sent and can retry without resending a message`, async () => {
    const nativeFetch = globalThis.fetch;
    let sends = 0;
    let failPreflight = true;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "GET" || url.endsWith("/users/@me/channels")) {
          if (failPreflight) throw new TypeError("preflight lost ACK");
          return init?.method === "GET"
            ? Response.json([])
            : Response.json({ id: "dm", ok: true, channel: { id: "dm" } });
        }
        sends++;
        return Response.json({ id: provider === "github" ? 1 : "1", ok: true, ts: "1" });
      },
      { preconnect: nativeFetch.preconnect },
    );
    try {
      const { adapter, address } =
        provider === "github"
          ? {
              adapter: new GitHubAdapter("secret", {}, () => undefined, injectedOptions(), "token"),
              address: "owner/repo#1",
            }
          : deliveryFixture(provider);
      expect(await adapter.deliver(address, Outbound.payload("SENTINEL"), "preflight")).toEqual({
        value: "not_sent",
      });
      expect(sends).toBe(0);
      failPreflight = false;
      expect(
        await adapter.deliver(address, Outbound.payload("SENTINEL"), "preflight"),
      ).toMatchObject({
        value: "sent",
      });
      expect(sends).toBe(1);
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });
}

test("Telegram never retries a transport failure whose prose resembles a parse refusal", async () => {
  let sends = 0;
  const restore = installDeliveryFetch(() => {
    sends++;
    throw new TypeError("can't parse entities: lost ACK");
  });
  try {
    const adapter = new TelegramAdapter("token", {}, () => undefined, injectedOptions());
    expect(await adapter.deliver("1", Outbound.payload("SENTINEL"), "key")).toEqual({
      value: "unknown",
    });
    expect(await adapter.deliver("1", Outbound.payload("SENTINEL"), "key")).toEqual({
      value: "unknown",
    });
    expect(sends).toBe(1);
  } finally {
    restore();
  }
});
