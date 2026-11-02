import { describe, expect, it } from "bun:test";
import { Operational, Outbound } from "@oni/protocol";
import { z } from "zod";
import { DiscordAccountAdapter } from "../src/provider/discord/account.js";
import { createDiscordProvider } from "../src/provider/discord/provider.js";
import { discordAccountSdk } from "../src/provider/discord/account-sdk.js";
import type { PublishPort } from "../src/types.js";
import { infoCollector } from "./helpers/observation.js";
import { inboundQueue } from "./helpers/inbound-queue.js";
import { fakeDiscordSdk } from "./helpers/discord-sdk.js";
import {
  FakeDiscordAccountListener,
  fakeDiscordAccountSdk,
  ACCOUNT_READY,
} from "./helpers/discord-account-sdk.js";
import { injectedOptions } from "./helpers/injected.js";
import { recordHttp } from "./helpers/http.js";

const noopPublish: PublishPort = () => undefined;
/** One started Account instance over the scripted user SDK, with an inbound queue. */
async function started(
  publish: PublishPort = noopPublish,
  listener?: FakeDiscordAccountListener,
) {
  const fake = fakeDiscordAccountSdk(listener);
  const adapter = new DiscordAccountAdapter(
    { token: "account-token" },
    publish,
    injectedOptions(),
    fake.sdk,
  );
  const queue = inboundQueue(adapter);
  await adapter.start("boot");
  return { ...fake, adapter, ...queue };
}

/**
 * Dispatches are handed off in arrival order, so a DM that follows the
 * dispatches under test proves every earlier one was decided.
 */
const SENTINEL = {
  id: "m-sentinel",
  channel_id: "D-account",
  author: { id: "U7", username: "friend" },
  content: "sentinel",
};

describe("DiscordAccountAdapter: a user account as the discord:account instance (#1569 lane 6)", () => {
  it("logs in with the account token, verifies identity through the Account SDK, and opens the gateway listener under the default posture", async () => {
    const { infos, publish } = infoCollector();
    const { client, listener, adapter } = await started(publish);
    expect(adapter.id).toBe("channel:test:main");
    expect(client.logins).toEqual(["account-token"]);
    expect(client.calls.map(({ method }) => method)).toEqual(["testAuth"]);
    expect(listener.started).toBe(1);
    expect(infos.at(-1)).toEqual({
      msg: "discord account instance started",
      context: { userId: ACCOUNT_READY.user.id, username: "account", listener: true },
    });
    adapter.stop("stop");
    expect(listener.stopped).toBe(1);
    expect(infos.at(-1)?.msg).toBe("discord account instance stopped");
  });

  it("a DM to the Account and a mention of the Account reach the handler as received by the Account; other guild messages also reach it; own echo and reactions do not", async () => {
    const { listener, next, inbound } = await started();
    const dm = next();
    listener.dispatch("MESSAGE_CREATE", {
      id: "m-dm",
      channel_id: "D-account",
      author: { id: "U7", username: "friend" },
      content: "around?",
    });
    expect(await dm).toMatchObject({
      sender: { kind: "external", surface: "discord", externalId: "U7" },
      facts: { eventId: "m-dm", event: "message", dm: true, },
    });
    const mention = next();
    listener.dispatch("MESSAGE_CREATE", {
      id: "m-mention",
      channel_id: "C1",
      guild_id: "G1",
      author: { id: "U7", username: "friend" },
      content: "<@U-account> thoughts?",
      mentions: [{ id: "U-account", username: "account" }],
    });
    expect(await mention).toMatchObject({
      facts: {
        eventId: "m-mention",
        event: "mention",
        dm: false,
        workspaceId: "G1",
        },
    });
    listener.dispatch("MESSAGE_CREATE", {
      id: "m-other",
      channel_id: "C1",
      guild_id: "G1",
      author: { id: "U7", username: "friend" },
      content: "unrelated",
    });
    listener.dispatch("MESSAGE_CREATE", {
      id: "m-self",
      channel_id: "D-account",
      author: { id: "U-account", username: "account" },
      content: "my own",
    });
    // A reaction is never ingress.
    listener.dispatch("MESSAGE_REACTION_ADD", {
      user_id: "U7",
      message_id: "m-dm",
      channel_id: "D-account",
      emoji: { name: "👀" },
    });
    const sentinel = next();
    listener.dispatch("MESSAGE_CREATE", SENTINEL);
    await sentinel;
    expect(inbound.map((message) => message.facts.eventId)).toEqual([
      "m-dm",
      "m-mention",
      "m-other",
      SENTINEL.id,
    ]);
  });

  it("every guild message reaches the handler", async () => {
    const everything = await started();
    everything.listener.dispatch("MESSAGE_CREATE", {
      id: "m-all",
      channel_id: "C1",
      guild_id: "G1",
      author: { id: "U7", username: "friend" },
      content: "unrelated",
    });
    const sentinel = everything.next();
    everything.listener.dispatch("MESSAGE_CREATE", SENTINEL);
    await sentinel;
    expect(everything.inbound.map((message) => message.facts.eventId)).toEqual([
      "m-all",
      SENTINEL.id,
    ]);
  });

  it("an error before READY fails start; a non-recoverable close after it is a typed dead surface", async () => {
    const refusing = new FakeDiscordAccountListener((self) =>
      self.emit("error", new Error("Discord gateway refused: 401")),
    );
    const fake = fakeDiscordAccountSdk(refusing);
    const adapter = new DiscordAccountAdapter(
      { token: "account-token" },
      noopPublish,
      injectedOptions(),
      fake.sdk,
    );
    adapter.onMessage(async () => undefined);
    await expect(adapter.start("boot")).rejects.toThrow("Discord gateway refused: 401");
    const errors: string[] = [];
    const { listener } = await started((event, data) => {
      if (event.name === Operational.Events.Error.name)
        errors.push(z.object({ msg: z.string() }).parse(data).msg);
    });
    listener.emit("error", new Error("Discord gateway closed with non-recoverable code 4004"));
    expect(listener.stopped).toBe(1);
    expect(errors).toEqual([
      "discord account gateway dead: Discord gateway closed with non-recoverable code 4004",
    ]);
  });

  it("delivers as the Account through the SDK client, one attempt per key", async () => {
    const account = fakeDiscordAccountSdk();
    const arm = createDiscordProvider(fakeDiscordSdk().sdk, account.sdk).account;
    if (arm === undefined) throw new Error("discord account arm missing");
    expect(arm.listen).toBe(true);
    expect(arm.capabilities).toMatchObject({ deliver: true, react: true, typing: true });
    expect(arm.credentials.safeParse({ token: "Bot abc" }).success).toBe(false);
    expect(arm.credentials.safeParse({ token: "abc", extra: 1 }).success).toBe(false);
    const runtime = arm.create(
      { token: "account-token" },
      noopPublish,
      injectedOptions(),
    );
    expect(runtime.surface.id).toBe("channel:test:main");
    expect(runtime.typingRoute).toBeDefined();
    await runtime.surface.start("boot");
    expect(await runtime.deliveryRoute?.("U7", Outbound.payload("as the Account"), "k-1")).toEqual({
      value: "accepted",
      externalMessageId: "m-1",
    });
    expect(account.client.calls.map(({ method }) => method)).toEqual([
      "testAuth",
      "createDM",
      "createMessage",
    ]);
    // Replayed under the same key: nothing leaves twice.
    expect(await runtime.deliveryRoute?.("U7", Outbound.payload("as the Account"), "k-1")).toEqual({
      value: "accepted",
      externalMessageId: "m-1",
    });
    expect(account.client.calls).toHaveLength(3);
  });

  it("sends Account identity, DM, and content requests with bare account authorization", async () => {
    const wire = recordHttp((request) => {
      if (request.url.endsWith("/users/@me"))
        return Response.json({ id: "account-id", username: "account" });
      if (request.url.endsWith("/users/@me/channels")) return Response.json({ id: "dm-channel" });
      return Response.json({ id: "posted-id" });
    });
    try {
      const arm = createDiscordProvider(fakeDiscordSdk().sdk, discordAccountSdk()).account;
      if (arm === undefined) throw new Error("discord account arm missing");
      const runtime = arm.create(
        { token: "account-private-credential" },
        noopPublish,
        injectedOptions(),
      );
      await runtime.surface.start("boot");
      expect(
        await runtime.deliveryRoute?.(
          "target-person",
          Outbound.payload("account content"),
          "account-key",
        ),
      ).toEqual({
        value: "accepted",
        externalMessageId: "posted-id",
      });
      expect(
        await runtime.deliveryRoute?.(
          "target-person",
          Outbound.payload("account content"),
          "account-key",
        ),
      ).toEqual({
        value: "accepted",
        externalMessageId: "posted-id",
      });
      expect(
        wire.requests.map((request) => [request.method, new URL(request.url).pathname]),
      ).toEqual([
        ["GET", "/api/v10/users/@me"],
        ["POST", "/api/v10/users/@me/channels"],
        ["POST", "/api/v10/channels/dm-channel/messages"],
      ]);
      expect(wire.requests.map((request) => request.headers.get("Authorization"))).toEqual([
        "account-private-credential",
        "account-private-credential",
        "account-private-credential",
      ]);
      expect(await wire.requests[1]?.json()).toEqual({ recipient_id: "target-person" });
      expect(await wire.requests[2]?.json()).toMatchObject({ content: "account content" });
    } finally {
      wire.restore();
    }
  });

  it("types as the Account: a DM channel is opened once per turn, a named conversation is reused, every pulse posts typing", async () => {
    const { adapter, client } = await started();
    expect(await adapter.openTyping("U7", { channelId: "C1" })).toEqual({ channelId: "C1" });
    expect(await adapter.openTyping("U7")).toEqual({ channelId: "D-account" });
    await adapter.typing({ channelId: "D-account" });
    expect(client.calls.map(({ method }) => method)).toContain("triggerTyping");
    expect(
      await adapter.deliver("U7", Outbound.payload("direct"), "k-2", { channelId: "C1" }),
    ).toEqual({
      value: "sent",
      externalMessageId: "m-1",
    });
  });

  it("replaces a reaction through the Account SDK and anchors its message", async () => {
    const { adapter } = await started();
    expect(
      await adapter.deliver(
        "U7",
        {
          kind: "react",
          messageId: "m-1",
          emoji: "✅",
          replaces: "👀",
        },
        "account-reaction",
        { channelId: "C1" },
      ),
    ).toEqual({ value: "sent", externalMessageId: "m-1" });
  });
});

it("#1600: a Discord Account instance names its account once started, never before", async () => {
  const fake = fakeDiscordAccountSdk();
  const adapter = new DiscordAccountAdapter(
    { token: "account-token" },
    noopPublish,
    injectedOptions(),
    fake.sdk,
  );
  expect(adapter.accountIdentity()).toBeUndefined();
  const { adapter: live } = await started();
  expect(live.accountIdentity()).toEqual({ externalId: "U-account" });
});
