import { afterEach, describe, expect, it } from "bun:test";
import { injectedOptions } from "./helpers/injected";
import { Operational, Outbound } from "@oni/protocol";
import { createDiscordProvider } from "../src/provider/discord/provider";
import { fakeDiscordSdk } from "./helpers/discord-sdk";
import { GitHubProvider } from "../src/provider/github/provider";
import { createSlackProvider } from "../src/provider/slack/provider";
import { fakeSlackSdk } from "./helpers/slack-sdk";
import { createTelegramProvider } from "../src/provider/telegram/provider";
import { fakeTelegramSdk } from "./helpers/telegram-sdk";
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

const ROUTES: readonly (readonly [string, string | undefined, object])[] = [
  ["slack.com", "/api/conversations.open", { ok: true, channel: { id: "D1" } }],
  ["discord.com", "/api/v10/users/@me/channels", { id: "dm-1" }],
  ["api.telegram.org", undefined, { ok: true, result: { message_id: 5 } }],
  ["slack.com", undefined, { ok: true, ts: "1.2" }],
];

describe("provider retry and receipt paths", () => {
  it("provider delivery routes return accepted receipts", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "api.github.com") return jsonResponse(init?.method === "POST" ? { id: 42 } : []);
      const route = ROUTES.find(([host, path]) => url.hostname === host && (path === undefined || url.pathname === path));
      return jsonResponse(route?.[2] ?? { id: "m-9" });
    }) as typeof fetch;

    const telegramSdk = fakeTelegramSdk();
    const telegram = await createTelegramProvider(telegramSdk.sdk).create(
      { token: "t" },
      {},
      () => undefined,
      injectedOptions(),
    ).deliveryRoute?.("100", Outbound.payload("hello"), "key-1");
    const discordSdk = fakeDiscordSdk();
    const discord = await createDiscordProvider(discordSdk.sdk).create(
      { token: "t" },
      {},
      () => undefined,
      injectedOptions(),
    ).deliveryRoute?.("user-1", Outbound.payload("hello"), "key-2");
    // #1569: Slack posts through the agent-messenger SDK, not fetch; the scripted client answers ts 1.2.
    const slack = await createSlackProvider(fakeSlackSdk({ postedTs: "1.2" }).sdk)
      .create({ botToken: "xoxb-1", appToken: "xapp-1" }, {}, () => undefined, injectedOptions())
      .deliveryRoute?.("T1:U1", Outbound.payload("hello"), "key-3");
    const github = await GitHubProvider.create(
      { secret: "s", token: "t" },
      {},
      () => undefined,
      injectedOptions(),
    ).deliveryRoute?.("owner/repo#1", Outbound.payload("hello"), "key-4");

    expect(telegram).toEqual({ value: "accepted", externalMessageId: "42" });
    expect(discord).toEqual({ value: "accepted", externalMessageId: "m-17" });
    expect(slack).toEqual({ value: "accepted", externalMessageId: "1.2" });
    expect(github).toEqual({ value: "accepted", externalMessageId: "42" });
  });
});

describe("Discord gateway surface", () => {
  it("drops malformed message payloads with an operational warning", async () => {
    const { published, publish } = collector();
    const fake = fakeDiscordSdk();
    const runtime = createDiscordProvider(fake.sdk).create(
      { token: "token" },
      {},
      publish,
      injectedOptions(),
    );
    runtime.surface.onMessage(async () => undefined);
    await runtime.surface.start("boot");
    fake.listener.dispatch("MESSAGE_CREATE", { nope: true });
    expect(published.filter((name) => name === Operational.Events.Warn.name)).toHaveLength(1);
    expect(runtime.typingRoute).toBeDefined();
  });
});
