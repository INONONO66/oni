import { describe, expect, it } from "bun:test";
import { Operational, Outbound } from "@oni/protocol";
import { z } from "zod";
import type { OwnerPosture } from "../src/provider/contract";
import { DiscordOwnerAdapter } from "../src/provider/discord/owner";
import { createDiscordProvider } from "../src/provider/discord/provider";
import { discordOwnerSdk } from "../src/provider/discord/owner-sdk";
import type { PublishPort } from "../src/types";
import { infoCollector } from "./helpers/observation";
import { inboundQueue } from "./helpers/inbound-queue";
import { fakeDiscordSdk } from "./helpers/discord-sdk";
import {
  FakeDiscordOwnerListener,
  fakeDiscordOwnerSdk,
  OWNER_READY,
} from "./helpers/discord-owner-sdk";
import { injectedOptions } from "./helpers/injected";
import { recordHttp } from "./helpers/http";

const noopPublish: PublishPort = () => undefined;
const DEFAULT_INTAKE: OwnerPosture = { intake: "mentions_and_dms", autoReply: false };
/** One started Owner instance over the scripted user SDK, with an inbound queue. */
async function started(
  posture: OwnerPosture = DEFAULT_INTAKE,
  publish: PublishPort = noopPublish,
  listener?: FakeDiscordOwnerListener,
) {
  const fake = fakeDiscordOwnerSdk(listener);
  const adapter = new DiscordOwnerAdapter(
    { token: "owner-token" },
    posture,
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
  channel_id: "D-owner",
  author: { id: "U7", username: "friend" },
  content: "sentinel",
};

describe("DiscordOwnerAdapter: the Owner's own account as the discord:owner instance (#1569 lane 6)", () => {
  it("logs in with the account token, verifies identity through the Owner SDK, and opens the gateway listener under the default posture", async () => {
    const { infos, publish } = infoCollector();
    const { client, listener, adapter } = await started(DEFAULT_INTAKE, publish);
    expect(adapter.id).toBe("discord:owner");
    expect(client.logins).toEqual(["owner-token"]);
    expect(client.calls.map(({ method }) => method)).toEqual(["testAuth"]);
    expect(listener.started).toBe(1);
    expect(infos.at(-1)).toEqual({
      msg: "discord owner instance started",
      context: { userId: OWNER_READY.user.id, username: "owner", listener: "mentions_and_dms" },
    });
    adapter.stop("stop");
    expect(listener.stopped).toBe(1);
    expect(infos.at(-1)?.msg).toBe("discord owner instance stopped");
  });

  it("a DM to the Owner and a mention of the Owner reach the handler as received by the Owner; other guild messages, own echo and reactions do not", async () => {
    const { listener, next, inbound } = await started();
    const dm = next();
    listener.dispatch("MESSAGE_CREATE", {
      id: "m-dm",
      channel_id: "D-owner",
      author: { id: "U7", username: "friend" },
      content: "around?",
    });
    expect(await dm).toMatchObject({
      sender: { kind: "external", surface: "discord", externalId: "U7" },
      facts: { eventId: "m-dm", event: "message", dm: true, receivedBy: "owner" },
    });
    const mention = next();
    listener.dispatch("MESSAGE_CREATE", {
      id: "m-mention",
      channel_id: "C1",
      guild_id: "G1",
      author: { id: "U7", username: "friend" },
      content: "<@U-owner> thoughts?",
      mentions: [{ id: "U-owner", username: "owner" }],
    });
    expect(await mention).toMatchObject({
      facts: {
        eventId: "m-mention",
        event: "mention",
        dm: false,
        workspaceId: "G1",
        receivedBy: "owner",
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
      channel_id: "D-owner",
      author: { id: "U-owner", username: "owner" },
      content: "my own",
    });
    // A reaction is never intake.
    listener.dispatch("MESSAGE_REACTION_ADD", {
      user_id: "U7",
      message_id: "m-dm",
      channel_id: "D-owner",
      emoji: { name: "👀" },
    });
    const sentinel = next();
    listener.dispatch("MESSAGE_CREATE", SENTINEL);
    await sentinel;
    expect(inbound.map((message) => message.facts.eventId)).toEqual([
      "m-dm",
      "m-mention",
      SENTINEL.id,
    ]);
  });

  it("under `all` every guild message is intake; under `none` no listener opens", async () => {
    const everything = await started({ intake: "all", autoReply: false });
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
    const sendOnly = await started({ intake: "none", autoReply: false });
    expect(sendOnly.listener.started).toBe(0);
  });

  it("an error before READY fails start; a non-recoverable close after it is a typed dead surface", async () => {
    const refusing = new FakeDiscordOwnerListener((self) =>
      self.emit("error", new Error("Discord gateway refused: 401")),
    );
    const fake = fakeDiscordOwnerSdk(refusing);
    const adapter = new DiscordOwnerAdapter(
      { token: "owner-token" },
      DEFAULT_INTAKE,
      noopPublish,
      injectedOptions(),
      fake.sdk,
    );
    adapter.onMessage(async () => undefined);
    await expect(adapter.start("boot")).rejects.toThrow("Discord gateway refused: 401");
    const errors: string[] = [];
    const { listener } = await started(DEFAULT_INTAKE, (event, data) => {
      if (event.name === Operational.Events.Error.name)
        errors.push(z.object({ msg: z.string() }).parse(data).msg);
    });
    listener.emit("error", new Error("Discord gateway closed with non-recoverable code 4004"));
    expect(listener.stopped).toBe(1);
    expect(errors).toEqual([
      "discord owner gateway dead: Discord gateway closed with non-recoverable code 4004",
    ]);
  });

  it("delivers as the Owner through the SDK client, one attempt per key", async () => {
    const owner = fakeDiscordOwnerSdk();
    const arm = createDiscordProvider(fakeDiscordSdk().sdk, owner.sdk).owner;
    if (arm === undefined) throw new Error("discord owner arm missing");
    expect(arm.listen).toBe(true);
    expect(arm.capabilities).toMatchObject({ deliver: true, react: true, typing: true });
    expect(arm.credentials.safeParse({ token: "Bot abc" }).success).toBe(false);
    expect(arm.credentials.safeParse({ token: "abc", extra: 1 }).success).toBe(false);
    const runtime = arm.create(
      { token: "owner-token" },
      { intake: "none", autoReply: false },
      noopPublish,
      injectedOptions(),
    );
    expect(runtime.surface.id).toBe("discord:owner");
    expect(runtime.typingRoute).toBeDefined();
    await runtime.surface.start("boot");
    expect(await runtime.deliveryRoute?.("U7", Outbound.payload("as the Owner"), "k-1")).toEqual({
      value: "accepted",
      externalMessageId: "m-1",
    });
    expect(owner.client.calls.map(({ method }) => method)).toEqual([
      "testAuth",
      "createDM",
      "createMessage",
    ]);
    // Replayed under the same key: nothing leaves twice.
    expect(await runtime.deliveryRoute?.("U7", Outbound.payload("as the Owner"), "k-1")).toEqual({
      value: "accepted",
      externalMessageId: "m-1",
    });
    expect(owner.client.calls).toHaveLength(3);
  });

  it("sends Owner identity, DM, and content requests with bare account authorization", async () => {
    const wire = recordHttp((request) => {
      if (request.url.endsWith("/users/@me"))
        return Response.json({ id: "owner-id", username: "owner" });
      if (request.url.endsWith("/users/@me/channels")) return Response.json({ id: "dm-channel" });
      return Response.json({ id: "posted-id" });
    });
    try {
      const arm = createDiscordProvider(fakeDiscordSdk().sdk, discordOwnerSdk()).owner;
      if (arm === undefined) throw new Error("discord owner arm missing");
      const runtime = arm.create(
        { token: "owner-private-credential" },
        { intake: "none", autoReply: false },
        noopPublish,
        injectedOptions(),
      );
      await runtime.surface.start("boot");
      expect(
        await runtime.deliveryRoute?.(
          "target-person",
          Outbound.payload("owner content"),
          "owner-key",
        ),
      ).toEqual({
        value: "accepted",
        externalMessageId: "posted-id",
      });
      expect(
        await runtime.deliveryRoute?.(
          "target-person",
          Outbound.payload("owner content"),
          "owner-key",
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
        "owner-private-credential",
        "owner-private-credential",
        "owner-private-credential",
      ]);
      expect(await wire.requests[1]?.json()).toEqual({ recipient_id: "target-person" });
      expect(await wire.requests[2]?.json()).toMatchObject({ content: "owner content" });
    } finally {
      wire.restore();
    }
  });

  it("types as the Owner: a DM channel is opened once per turn, a named conversation is reused, every pulse posts typing", async () => {
    const { adapter, client } = await started({ intake: "none", autoReply: false });
    expect(await adapter.openTyping("U7", { channelId: "C1" })).toEqual({ channelId: "C1" });
    expect(await adapter.openTyping("U7")).toEqual({ channelId: "D-owner" });
    await adapter.typing({ channelId: "D-owner" });
    expect(client.calls.map(({ method }) => method)).toContain("triggerTyping");
    expect(
      await adapter.deliver("U7", Outbound.payload("direct"), "k-2", { channelId: "C1" }),
    ).toEqual({
      value: "sent",
      externalMessageId: "m-1",
    });
  });

  it("replaces a reaction through the Owner SDK and anchors its message", async () => {
    const { adapter } = await started({ intake: "none", autoReply: false });
    expect(
      await adapter.deliver(
        "U7",
        {
          kind: "react",
          messageId: "m-1",
          emoji: "✅",
          replaces: "👀",
        },
        "owner-reaction",
        { channelId: "C1" },
      ),
    ).toEqual({ value: "sent", externalMessageId: "m-1" });
  });
});

it("#1600: a Discord Owner instance names its account once started, never before", async () => {
  const fake = fakeDiscordOwnerSdk();
  const adapter = new DiscordOwnerAdapter(
    { token: "owner-token" },
    DEFAULT_INTAKE,
    noopPublish,
    injectedOptions(),
    fake.sdk,
  );
  expect(adapter.accountIdentity()).toBeUndefined();
  const { adapter: live } = await started();
  expect(live.accountIdentity()).toEqual({ externalId: "U-owner" });
});
