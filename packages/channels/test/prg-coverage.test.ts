import { afterEach, describe, expect, it } from "bun:test";
import { injectedOptions, testRun } from "./helpers/injected";
import { Operational, Outbound } from "@openomni/protocol";
import { DiscordClient } from "../src/provider/discord/client";
import { DiscordAdapter } from "../src/provider/discord/surface";
import type { DiscordGateway } from "../src/provider/discord/gateway";

type GatewayCallbacks = ConstructorParameters<typeof DiscordGateway>[2];
import { DiscordProvider } from "../src/provider/discord/provider";
import { GitHubProvider } from "../src/provider/github/provider";
import { SlackProvider } from "../src/provider/slack/provider";
import { TelegramClient } from "../src/provider/telegram/client";
import { TelegramProvider } from "../src/provider/telegram/provider";
import type { PublishPort } from "../src/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function collector(): { published: string[]; publish: PublishPort } {
  const published: string[] = [];
  return {
    published,
    publish: (event) => {
      published.push(event.name);
    },
  };
}

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("provider retry and receipt paths", () => {
  it.each([
    {
      name: "Discord",
      limited: { retry_after: 0 },
      success: { id: "m1" },
      address: "channel-1",
      id: "m1",
      client: (publish: PublishPort) => new DiscordClient("token", publish, testRun),
    },
    {
      name: "Telegram",
      limited: { parameters: { retry_after: 0 } },
      success: { ok: true, result: { message_id: 7 } },
      address: "chat-1",
      id: "7",
      client: (publish: PublishPort) => new TelegramClient("token", publish, testRun),
    },
  ])("retries $name rate limits and returns the platform id", async (scenario) => {
    const { published, publish } = collector();
    let calls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        calls += 1;
        return calls === 1
          ? Response.json(scenario.limited, { status: 429 })
          : Response.json(scenario.success);
      },
      { preconnect: realFetch.preconnect },
    );
    // retry_after 0 hint: the Effect retry sleeps zero — no clock control needed.
    const id = await scenario.client(publish).send(scenario.address, "hello", "trace-1");
    expect(id).toBe(scenario.id);
    expect(calls).toBe(2);
    expect(published).toContain(Operational.Events.Warn.name);
  });

  it("provider delivery routes return accepted receipts", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "api.github.com")
        return init?.method === "POST" ? jsonResponse({ id: 42 }) : jsonResponse([]);
      if (url.hostname === "slack.com" && url.pathname === "/api/conversations.open")
        return jsonResponse({ ok: true, channel: { id: "D1" } });
      if (url.hostname === "discord.com" && url.pathname === "/api/v10/users/@me/channels")
        return jsonResponse({ id: "dm-1" });
      if (url.hostname === "api.telegram.org")
        return jsonResponse({ ok: true, result: { message_id: 5 } });
      if (url.hostname === "slack.com") return jsonResponse({ ok: true, ts: "1.2" });
      return jsonResponse({ id: "m-9" });
    }) as typeof fetch;

    const telegram = await TelegramProvider.create(
      { token: "t" },
      {},
      () => undefined,
      injectedOptions(),
    ).deliveryRoute?.("100", Outbound.payload("hello"), "key-1");
    const discord = await DiscordProvider.create(
      { token: "t" },
      {},
      () => undefined,
      injectedOptions(),
    ).deliveryRoute?.("user-1", Outbound.payload("hello"), "key-2");
    const slack = await SlackProvider.create(
      { botToken: "xoxb-1", appToken: "xapp-1" },
      {},
      () => undefined,
      injectedOptions(),
    ).deliveryRoute?.("T1:U1", Outbound.payload("hello"), "key-3");
    const github = await GitHubProvider.create(
      { secret: "s", token: "t" },
      {},
      () => undefined,
      injectedOptions(),
    ).deliveryRoute?.("owner/repo#1", Outbound.payload("hello"), "key-4");

    expect(telegram).toEqual({ value: "accepted", externalMessageId: "5" });
    expect(discord).toEqual({ value: "accepted", externalMessageId: "m-9" });
    expect(slack).toEqual({ value: "accepted", externalMessageId: "1.2" });
    expect(github).toEqual({ value: "accepted", externalMessageId: "42" });
  });
});

describe("Discord gateway surface", () => {
  it("drops malformed message payloads with an operational warning", () => {
    const { published, publish } = collector();
    const adapter = new DiscordAdapter("token", {}, publish, injectedOptions());
    const harness = adapter as object as { gateway: { callbacks: GatewayCallbacks } };
    harness.gateway.callbacks.onDispatch("MESSAGE_CREATE", { nope: true }, "trace-1");
    harness.gateway.callbacks.onDispatch("TYPING_START", {}, "trace-2");
    expect(published.filter((name) => name === Operational.Events.Warn.name)).toHaveLength(1);
  });
});
