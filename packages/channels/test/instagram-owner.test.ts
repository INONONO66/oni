import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Channel, Operational, Outbound } from "@oni/protocol";
import { z } from "zod";
import type { OwnerPosture } from "../src/provider/contract";
import { InstagramOwnerAdapter } from "../src/provider/instagram/owner";
import { InstagramOwnerError, instagramOwnerSdk } from "../src/provider/instagram/owner-sdk";
import { createInstagramProvider } from "../src/provider/instagram/provider";
import { RECONNECT_ATTEMPT_BOUND } from "../src/support/sdk-listener";
import type { PublishPort } from "../src/types";
import { bounded } from "./helpers/bounded";
import { injectedOptions } from "./helpers/injected";
import {
  FakeInstagramOwnerListener,
  fakeInstagramOwnerSdk,
  INSTAGRAM_OWNER_ID,
  INSTAGRAM_SESSION,
  type InstagramScript,
} from "./helpers/instagram-owner-sdk";

const noopPublish: PublishPort = () => undefined;
const DEFAULT_INTAKE: OwnerPosture = { intake: "mentions_and_dms", autoReply: false };
const SEND_ONLY: OwnerPosture = { intake: "none", autoReply: false };

/** One started Owner instance over the scripted SDK, with an inbound queue. */
async function started(
  posture: OwnerPosture = DEFAULT_INTAKE,
  script: InstagramScript = {},
  publish: PublishPort = noopPublish,
  listener?: FakeInstagramOwnerListener,
) {
  const fake = fakeInstagramOwnerSdk(script, listener);
  const adapter = new InstagramOwnerAdapter({ session: INSTAGRAM_SESSION }, posture, publish, injectedOptions(), fake.sdk);
  const inbound: Channel.InboundMessage[] = [];
  const waiters: Array<(message: Channel.InboundMessage) => void> = [];
  const next = () => {
    const waiter = Promise.withResolvers<Channel.InboundMessage>();
    waiters.push(waiter.resolve);
    return bounded(waiter.promise);
  };
  adapter.onMessage(async (message) => {
    inbound.push(message);
    waiters.shift()?.(message);
  });
  await adapter.start("boot");
  return { ...fake, adapter, inbound, next };
}

/** The one shape the SDK's listener gives a refused inbox read, whatever the platform's reason. */
const inboxRefused = () => new InstagramOwnerError("Failed to fetch inbox", "inbox_error");

/** Messages are handed off in arrival order: a sentinel that follows proves every earlier one was decided. */
const SENTINEL = { id: "ig-sentinel", thread_id: "t-sentinel", from: "900", text: "sentinel" };

describe("InstagramOwnerAdapter: the Owner's own account as the instagram:owner instance (#1569 lane 7)", () => {
  it("restores the vault session through a file it removes, leaves the SDK nothing to persist, and opens the inbox listener", async () => {
    const infos: Pick<ReturnType<typeof Operational.Events.Info.schema.parse>, "msg" | "context">[] = [];
    const { client, listener, adapter } = await started(DEFAULT_INTAKE, {}, (event, data) => {
      if (event.name !== Operational.Events.Info.name) return;
      const { msg, context } = Operational.Events.Info.schema.parse(data);
      infos.push(context === undefined ? { msg } : { msg, context });
    });
    expect(adapter.id).toBe("instagram:owner");
    expect(client.loaded).toEqual({ existed: true, session: INSTAGRAM_SESSION });
    // The file is gone and the SDK has no path to write a session back to.
    expect(client.sessionPath).toBe("");
    expect(listener.started).toBe(1);
    expect(listener.pollInterval).toBe(5_000);
    expect(infos.at(-1)).toEqual({
      msg: "instagram owner instance started",
      context: { userId: INSTAGRAM_OWNER_ID, listener: "mentions_and_dms" },
    });
    adapter.stop("stop");
    expect(listener.stopped).toBe(1);
  });

  it("a session that names no account fails start", async () => {
    const fake = fakeInstagramOwnerSdk();
    const adapter = new InstagramOwnerAdapter(
      { session: JSON.stringify({ cookies: "sessionid=abc", device: {} }) },
      SEND_ONLY,
      noopPublish,
      injectedOptions(),
      fake.sdk,
    );
    await expect(adapter.start("boot")).rejects.toMatchObject({ _tag: "ChannelsFailure", operation: "instagram.owner.start" });
    expect(fake.client.sessionPath).toBe("");
    const path = fake.client.loaded?.existed === true ? "" : "missing";
    expect(path).toBe("");
  });

  it("every inbox message is a DM to the Owner, received by the Owner; the account's own are never an outside event", async () => {
    const { listener, next, inbound } = await started();
    const dm = next();
    listener.message({ id: "ig-1", thread_id: "t-1", from: "500", from_name: "friend", text: "hey" });
    expect(await dm).toMatchObject({
      sender: { kind: "external", surface: "instagram", externalId: "500" },
      facts: { eventId: "ig-1", channelId: "t-1", dm: true, event: "message", receivedBy: "owner", render: "hey" },
    });
    listener.message({ id: "ig-2", thread_id: "t-1", from: INSTAGRAM_OWNER_ID, text: "my reply", is_outgoing: true });
    listener.message({ id: "ig-3", thread_id: "t-1", from: INSTAGRAM_OWNER_ID, text: "also mine" });
    listener.message({ id: "ig-4", thread_id: "t-1", from: "500" });
    const media = next();
    listener.message({ id: "ig-5", thread_id: "t-1", from: "500", type: "media", media_url: "https://cdn/i.jpg" });
    expect(await media).toMatchObject({ facts: { eventId: "ig-5", render: "", attachments: [{ kind: "image", ref: "https://cdn/i.jpg" }] } });
    const sentinel = next();
    listener.message(SENTINEL);
    await sentinel;
    expect(inbound.map((message) => message.facts.eventId)).toEqual(["ig-1", "ig-5", SENTINEL.id]);
  });

  it("under `none` no listener opens; under `all` the inbox reads the same", async () => {
    const sendOnly = await started(SEND_ONLY);
    expect(sendOnly.listener.started).toBe(0);
    const everything = await started({ intake: "all", autoReply: false });
    const dm = everything.next();
    everything.listener.message({ id: "ig-6", thread_id: "t-2", from: "501", text: "hi" });
    expect((await dm).facts.dm).toBe(true);
  });

  it("delivers into the person's thread, or opens the direct thread with them cold; a platform refusal is not_sent, a lost response unknown", async () => {
    const { adapter, client } = await started(SEND_ONLY);
    expect(await adapter.deliver("500", Outbound.payload("into the thread"), "k-1", { channelId: "t-1" })).toEqual({
      value: "sent",
      externalMessageId: "ig-1",
    });
    expect(await adapter.deliver("500", Outbound.payload("cold"), "k-2")).toEqual({ value: "sent", externalMessageId: "ig-2" });
    expect(client.of("sendMessage").map((call) => call.args)).toEqual([["t-1", "into the thread"]]);
    expect(client.of("sendMessageToUser").map((call) => call.args)).toEqual([["500", "cold"]]);
    const limited = await started(SEND_ONLY, { sendMessage: new InstagramOwnerError("Rate limited", "rate_limited") });
    expect((await limited.adapter.deliver("500", Outbound.payload("x"), "k-3", { channelId: "t-1" })).value).toBe("not_sent");
    const refused = await started(SEND_ONLY, { sendMessageToUser: new InstagramOwnerError("Failed to send message", "send_failed") });
    expect((await refused.adapter.deliver("500", Outbound.payload("x"), "k-4")).value).toBe("not_sent");
    const lost = await started(SEND_ONLY, { sendMessage: new Error("socket hang up") });
    expect((await lost.adapter.deliver("500", Outbound.payload("x"), "k-5", { channelId: "t-1" })).value).toBe("unknown");
  });

  it("a realtime failure at boot hands over to polling; a streak of refused inbox reads is a typed dead surface; a refused read or a second failure at boot leaves no listener", async () => {
    const seen: string[] = [];
    const publish: PublishPort = (event, data) => {
      const { msg } = z.object({ msg: z.string() }).parse(data);
      if (event.name === Operational.Events.Error.name || event.name === Operational.Events.Warn.name)
        seen.push(`${event.name}: ${msg}`);
    };
    // The SDK's hybrid emits its realtime failure first, then the poller's `connected` after its first inbox read.
    const hybrid = new FakeInstagramOwnerListener((self) => {
      self.emit("error", new Error("MQTToT CONNACK timed out"));
      self.emit("connected", { userId: INSTAGRAM_OWNER_ID, transport: "polling" });
    });
    const { listener, next } = await started(DEFAULT_INTAKE, {}, publish, hybrid);
    expect(listener.stopped).toBe(0);
    expect(seen).toEqual([`${Operational.Events.Warn.name}: instagram inbox error, sdk falling back`]);
    const dm = next();
    listener.message({ id: "ig-7", thread_id: "t-3", from: "502", text: "still read" });
    expect((await dm).facts.eventId).toBe("ig-7");
    // Every refused read is the SDK's one code (a revoked session and an outage alike): a message or a
    // reconnect ends the streak, a streak as long as custody's bound ends the surface.
    seen.length = 0;
    const errorsSeen = () => seen.filter((line) => line.startsWith(Operational.Events.Error.name));
    const unreachable = `${Operational.Events.Error.name}: instagram inbox unreachable: ${RECONNECT_ATTEMPT_BOUND} failures without a reconnect`;
    for (let i = 0; i < RECONNECT_ATTEMPT_BOUND - 1; i += 1) listener.emit("error", inboxRefused());
    const read = next();
    listener.message({ id: "ig-8", thread_id: "t-3", from: "502", text: "readable again" });
    await read;
    // The tenth refused read since the reconnect is custody's unreachable alarm, not the dead surface: the message ended the refusal streak.
    listener.emit("error", inboxRefused());
    expect(listener.stopped).toBe(0);
    expect(errorsSeen()).toEqual([unreachable]);
    listener.emit("connected", { userId: INSTAGRAM_OWNER_ID, transport: "realtime" });
    for (let i = 0; i < RECONNECT_ATTEMPT_BOUND; i += 1) listener.emit("error", inboxRefused());
    expect(listener.stopped).toBe(1);
    expect(errorsSeen()).toEqual([unreachable, `${Operational.Events.Error.name}: instagram inbox dead: Failed to fetch inbox`]);
    listener.emit("error", inboxRefused());
    expect(listener.stopped).toBe(1);
    // At boot a refused inbox read is the poller's own first cycle failing; so is any second error.
    for (const [second, message] of [
      [inboxRefused(), "Failed to fetch inbox"],
      [new Error("poll failed"), "poll failed"],
    ] as const) {
      const refusing = new FakeInstagramOwnerListener((self) => {
        self.emit("error", new Error("MQTToT CONNACK timed out"));
        self.emit("error", second);
      });
      const fake = fakeInstagramOwnerSdk({}, refusing);
      const adapter = new InstagramOwnerAdapter({ session: INSTAGRAM_SESSION }, DEFAULT_INTAKE, noopPublish, injectedOptions(), fake.sdk);
      adapter.onMessage(async () => undefined);
      await expect(adapter.start("boot")).rejects.toThrow(message);
      expect(refusing.stopped).toBe(1);
    }
  });

  it("the provider is Owner-only: the owner arm builds the instance with delivery and no typing; the bot arm refuses", () => {
    const owner = fakeInstagramOwnerSdk();
    const provider = createInstagramProvider(owner.sdk);
    expect(provider.owner?.capabilities).toEqual({ deliver: true, react: false, media: false, typing: false });
    expect(provider.owner?.listen).toBe(true);
    expect(provider.owner?.credentials.safeParse({ session: INSTAGRAM_SESSION }).success).toBe(true);
    expect(provider.owner?.credentials.safeParse({ session: "not json" }).success).toBe(false);
    expect(provider.owner?.credentials.safeParse({ session: JSON.stringify({ device: {} }) }).success).toBe(false);
    expect(provider.owner?.credentials.safeParse({ session: INSTAGRAM_SESSION, extra: 1 }).success).toBe(false);
    const runtime = provider.owner?.create({ session: INSTAGRAM_SESSION }, SEND_ONLY, noopPublish, injectedOptions());
    expect(runtime?.surface.id).toBe("instagram:owner");
    expect(runtime?.deliveryRoute).toBeDefined();
    expect(runtime?.typingRoute).toBeUndefined();
    expect(provider.credentials.safeParse({ session: INSTAGRAM_SESSION }).success).toBe(false);
    expect(existsSync("/nonexistent/oni-instagram")).toBe(false);
  });

  it("the owner arm's delivery route folds the surface receipt into the kernel's custody vocabulary", async () => {
    const owner = fakeInstagramOwnerSdk();
    const arm = createInstagramProvider(owner.sdk).owner;
    if (arm === undefined) throw new Error("instagram owner arm missing");
    const runtime = arm.create({ session: INSTAGRAM_SESSION }, SEND_ONLY, noopPublish, injectedOptions());
    if (runtime.deliveryRoute === undefined) throw new Error("instagram owner arm mounts no delivery route");
    await runtime.surface.start("boot");
    expect(await runtime.deliveryRoute("500", Outbound.payload("as the Owner"), "k-1", { channelId: "t-1" })).toEqual({
      value: "accepted",
      externalMessageId: "ig-1",
    });
  });

  it("the production seam builds the SDK's client and inbox listener without any I/O", () => {
    const seam = instagramOwnerSdk();
    const client = seam.client();
    expect(client.getUserId()).toBeNull();
    expect(seam.listener(client, { pollInterval: 5_000 })).toBeDefined();
    const scratch = join(tmpdir(), "oni-instagram-login-seam-never-created");
    expect(seam.loginClient(scratch)).toBeDefined();
    expect(existsSync(scratch)).toBe(false);
  });
});

it("#1600: an Instagram Owner instance names its account once the session is restored", async () => {
  const { adapter } = await started();
  expect(adapter.account()).toEqual({ externalId: INSTAGRAM_OWNER_ID });
});
