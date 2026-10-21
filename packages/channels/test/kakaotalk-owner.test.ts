import { describe, expect, it } from "bun:test";
import { type Channel, Operational, Outbound } from "@oni/protocol";
import { z } from "zod";
import { DeliveryNotSent } from "../src/errors";
import type { OwnerPosture } from "../src/provider/contract";
import { KakaoTalkOwnerAdapter } from "../src/provider/kakaotalk/owner";
import { KakaoTalkOwnerError, kakaoTalkOwnerSdk } from "../src/provider/kakaotalk/owner-sdk";
import { createKakaoTalkProvider } from "../src/provider/kakaotalk/provider";
import type { EffectRunner, PublishPort } from "../src/types";
import { bounded } from "./helpers/bounded";
import { injectedOptions } from "./helpers/injected";
import {
  FakeKakaoTalkOwnerListener,
  fakeKakaoTalkOwnerSdk,
  KAKAO_OWNER,
  type KakaoScript,
} from "./helpers/kakaotalk-owner-sdk";

const noopPublish: PublishPort = () => undefined;
const DEFAULT_INTAKE: OwnerPosture = { intake: "mentions_and_dms", autoReply: false };
const SEND_ONLY: OwnerPosture = { intake: "none", autoReply: false };
const CREDENTIALS = { oauthToken: "oauth-1", userId: KAKAO_OWNER.user_id, deviceUuid: "dev-1", deviceType: "tablet" as const };
/** A direct chat with one person and a group of three, as the SDK reports them. */
const CHATS = { "chat-dm": { type: "DirectChat", active_members: 2 }, "chat-group": { type: "MultiChat", active_members: 3 } };
/** The driver's run port with every sleep elided: the reopen fires at once. */
const immediate: EffectRunner = () => Promise.resolve(undefined as never);

/** One started Owner instance over the scripted SDK, with an inbound queue. */
async function started(
  posture: OwnerPosture = DEFAULT_INTAKE,
  script: KakaoScript = { chats: CHATS },
  publish: PublishPort = noopPublish,
  listener?: FakeKakaoTalkOwnerListener,
) {
  const fake = fakeKakaoTalkOwnerSdk(script, listener);
  const adapter = new KakaoTalkOwnerAdapter(CREDENTIALS, posture, publish, injectedOptions(immediate), fake.sdk);
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

/** Settles on the listener's next `connected`. */
function connectedOnce(listener: FakeKakaoTalkOwnerListener): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  listener.on("connected", () => resolve());
  return promise;
}

/** Messages are handed off in arrival order: a sentinel DM that follows proves every earlier one was decided. */
const SENTINEL = { chat_id: "chat-dm", log_id: "log-sentinel", author_id: 2002, message: "sentinel" };

describe("KakaoTalkOwnerAdapter: the Owner's own account as the kakaotalk:owner instance (#1569 lane 7)", () => {
  it("logs the account in, reads its profile, and opens the push listener under the default posture", async () => {
    const infos: Pick<ReturnType<typeof Operational.Events.Info.schema.parse>, "msg" | "context">[] = [];
    const { client, listener, adapter } = await started(DEFAULT_INTAKE, { chats: CHATS }, (event, data) => {
      if (event.name !== Operational.Events.Info.name) return;
      const { msg, context } = Operational.Events.Info.schema.parse(data);
      infos.push(context === undefined ? { msg } : { msg, context });
    });
    expect(adapter.id).toBe("kakaotalk:owner");
    expect(client.calls.map((call) => call.method)).toEqual(["login", "getProfile"]);
    expect(client.calls[0]?.args).toEqual(["oauth-1", "1001", "dev-1", "tablet"]);
    expect(listener.started).toBe(1);
    expect(infos.at(-1)).toEqual({
      msg: "kakaotalk owner instance started",
      context: { userId: "1001", nickname: "ino", listener: "mentions_and_dms" },
    });
    adapter.stop("stop");
    expect(listener.stopped).toBe(1);
    expect(client.closed).toBe(1);
  });

  it("a direct chat is a DM to the Owner and a group message is intake only when it names the Owner; the account's own never is", async () => {
    const { listener, next, inbound, client } = await started();
    const dm = next();
    listener.message({ chat_id: "chat-dm", log_id: "log-1", author_id: 2002, message: "hey" });
    expect(await dm).toMatchObject({
      sender: { kind: "external", surface: "kakaotalk", externalId: "2002" },
      facts: { eventId: "log-1", channelId: "chat-dm", dm: true, event: "message", receivedBy: "owner", render: "hey" },
    });
    listener.message({ chat_id: "chat-group", log_id: "log-2", author_id: 2003, message: "group chatter" });
    const mention = next();
    listener.message({ chat_id: "chat-group", log_id: "log-3", author_id: 2003, message: "@ino look at this" });
    expect(await mention).toMatchObject({
      facts: { eventId: "log-3", channelId: "chat-group", dm: false, event: "mention", addressees: [{ externalId: "1001" }] },
    });
    listener.message({ chat_id: "chat-dm", log_id: "log-4", author_id: 1001, message: "my own" });
    const sentinel = next();
    listener.message(SENTINEL);
    await sentinel;
    expect(inbound.map((message) => message.facts.eventId)).toEqual(["log-1", "log-3", SENTINEL.log_id]);
    // A chat's shape is read once.
    expect(client.of("getChat").map((call) => call.args)).toEqual([["chat-dm"], ["chat-group"]]);
  });

  it("a chat the SDK cannot describe is treated as a group; under `all` everything is intake; under `none` no listener opens", async () => {
    const strict = await started(DEFAULT_INTAKE, { chats: {} });
    strict.listener.message({ chat_id: "chat-unknown", log_id: "log-5", author_id: 2002, message: "hello?" });
    const mention = strict.next();
    strict.listener.message({ chat_id: "chat-unknown", log_id: "log-6", author_id: 2002, message: "@ino hello?" });
    expect((await mention).facts.dm).toBe(false);
    expect(strict.inbound.map((message) => message.facts.eventId)).toEqual(["log-6"]);
    const everything = await started({ intake: "all", autoReply: false });
    const chatter = everything.next();
    everything.listener.message({ chat_id: "chat-group", log_id: "log-7", author_id: 2003, message: "group chatter" });
    expect((await chatter).facts.event).toBe("message");
    const sendOnly = await started(SEND_ONLY);
    expect(sendOnly.listener.started).toBe(0);
  });

  it("delivers into the conversation's chat, or into the direct chat the person last wrote from; a stranger cannot be reached cold", async () => {
    const { adapter, client, listener, next } = await started();
    expect(await adapter.deliver("2002", Outbound.payload("in chat"), "k-1", { channelId: "chat-group" })).toEqual({
      value: "sent",
      externalMessageId: "log-1",
    });
    // #1600 lane R3: nothing was attempted — the typed receipt, not a thrown failure.
    expect(await adapter.deliver("2002", Outbound.payload("cold"), "k-2")).toEqual({ value: "not_sent" });
    const dm = next();
    listener.message({ chat_id: "chat-dm", log_id: "log-9", author_id: 2002, message: "hi" });
    await dm;
    expect(await adapter.deliver("2002", Outbound.payload("warm"), "k-3")).toEqual({ value: "sent", externalMessageId: "log-2" });
    expect(client.of("sendMessage").map((call) => call.args)).toEqual([["chat-group", "in chat"], ["chat-dm", "warm"]]);
    // Typing rides the same chats.
    expect(await adapter.openTyping("2002", { channelId: "chat-group" })).toEqual({ channelId: "chat-group" });
    expect(await adapter.openTyping("2002")).toEqual({ channelId: "chat-dm" });
    await expect(adapter.openTyping("2009")).rejects.toBeInstanceOf(DeliveryNotSent);
    await adapter.typing({ channelId: "chat-dm" });
    expect(client.of("sendTyping").map((call) => call.args)).toEqual([["chat-dm"]]);
  });

  it("a refused send is not_sent, a preflight refusal is not_sent, a thrown send is unknown (the SDK may have re-run it), a socket closed before the reply is unknown and never re-sent", async () => {
    const refused = await started(SEND_ONLY, { chats: CHATS, send: { success: false, status_code: -500 } });
    expect((await refused.adapter.deliver("2002", Outbound.payload("x"), "k-1", { channelId: "chat-dm" })).value).toBe("not_sent");
    const preflight = await started(SEND_ONLY, { chats: CHATS, send: new KakaoTalkOwnerError("Not authenticated", "not_authenticated") });
    expect((await preflight.adapter.deliver("2002", Outbound.payload("x"), "k-2", { channelId: "chat-dm" })).value).toBe("not_sent");
    const thrown = await started(SEND_ONLY, { chats: CHATS, send: new KakaoTalkOwnerError("send failed", "send_message_failed") });
    expect((await thrown.adapter.deliver("2002", Outbound.payload("x"), "k-3", { channelId: "chat-dm" })).value).toBe("unknown");
    // The SDK answers a WRITE whose socket closed before the reply with its synthetic −1: the message may have landed.
    const closed = await started(SEND_ONLY, { chats: CHATS, send: { success: false, status_code: -1 } });
    expect((await closed.adapter.deliver("2002", Outbound.payload("x"), "k-4", { channelId: "chat-dm" })).value).toBe("unknown");
    expect((await closed.adapter.deliver("2002", Outbound.payload("x"), "k-4", { channelId: "chat-dm" })).value).toBe("unknown");
    expect(closed.client.of("sendMessage")).toHaveLength(1);
  });

  it("a dropped session is reopened by the surface (the SDK listener stopped, then started), a refused reopen takes the next backoff step, a session kicked by another device is a typed dead surface, a refused start leaves no listener", async () => {
    const errors: string[] = [];
    const pushes: string[] = [];
    // The third start — the second reopen — is refused by the LOCO booking.
    const flaky = new FakeKakaoTalkOwnerListener((self) => {
      if (self.started === 3) self.emit("error", new Error("LOGINLIST refused"));
      else self.emit("connected", { userId: KAKAO_OWNER.user_id });
    });
    const { listener } = await started(
      DEFAULT_INTAKE,
      { chats: CHATS },
      (event, data) => {
        const { msg } = z.object({ msg: z.string() }).parse(data);
        if (event.name === Operational.Events.Error.name) errors.push(msg);
        else if (msg.startsWith("kakaotalk push")) pushes.push(msg);
      },
      flaky,
    );
    // The SDK listener still counts itself running after a drop: a bare start would be a no-op.
    const reopened = connectedOnce(listener);
    listener.emit("disconnected");
    await bounded(reopened);
    expect({ stopped: listener.stopped, started: listener.started, running: listener.running }).toEqual({
      stopped: 1,
      started: 2,
      running: true,
    });
    // A reopen the booking refuses emits only `error`, never `disconnected`: the surface takes the next step.
    const retried = connectedOnce(listener);
    listener.emit("disconnected");
    await bounded(retried);
    expect({ stopped: listener.stopped, started: listener.started }).toEqual({ stopped: 3, started: 4 });
    expect(pushes).toEqual([
      "kakaotalk push closed, sdk reconnecting",
      "kakaotalk push reconnected",
      "kakaotalk push closed, sdk reconnecting",
      "kakaotalk push error",
      "kakaotalk push error, sdk reconnecting",
      "kakaotalk push reconnected",
    ]);
    listener.emit("error", new Error("Session kicked — another device logged in"));
    expect(listener.stopped).toBe(4);
    expect(errors).toEqual(["kakaotalk push dead: Session kicked — another device logged in"]);
    listener.emit("disconnected");
    await bounded(Promise.resolve());
    expect(listener.started).toBe(4);
    const refusing = new FakeKakaoTalkOwnerListener((self) => self.emit("error", new Error("LOCO booking refused")));
    const fake = fakeKakaoTalkOwnerSdk({ chats: CHATS }, refusing);
    const adapter = new KakaoTalkOwnerAdapter(CREDENTIALS, DEFAULT_INTAKE, noopPublish, injectedOptions(immediate), fake.sdk);
    adapter.onMessage(async () => undefined);
    await expect(adapter.start("boot")).rejects.toThrow("LOCO booking refused");
    expect(refusing.stopped).toBe(1);
  });

  it("the provider is Owner-only: the owner arm builds the instance with delivery and typing; the bot arm refuses", () => {
    const owner = fakeKakaoTalkOwnerSdk();
    const provider = createKakaoTalkProvider(owner.sdk);
    expect(provider.owner?.capabilities).toEqual({ deliver: true, react: false, media: false, typing: true });
    expect(provider.owner?.listen).toBe(true);
    expect(provider.owner?.credentials.safeParse(CREDENTIALS).success).toBe(true);
    expect(provider.owner?.credentials.safeParse({ oauthToken: "o", userId: "1" }).success).toBe(true);
    expect(provider.owner?.credentials.safeParse({ oauthToken: "o" }).success).toBe(false);
    expect(provider.owner?.credentials.safeParse({ ...CREDENTIALS, deviceType: "phone" }).success).toBe(false);
    const runtime = provider.owner?.create(CREDENTIALS, SEND_ONLY, noopPublish, injectedOptions());
    expect(runtime?.surface.id).toBe("kakaotalk:owner");
    expect(runtime?.deliveryRoute).toBeDefined();
    expect(runtime?.typingRoute).toBeDefined();
    expect(provider.credentials.safeParse(CREDENTIALS).success).toBe(false);
  });

  it("the owner arm's delivery and typing routes ride the surface: kernel receipts, a chat opened once per turn, a pulse per tick", async () => {
    const owner = fakeKakaoTalkOwnerSdk({ chats: CHATS });
    const arm = createKakaoTalkProvider(owner.sdk).owner;
    if (arm === undefined) throw new Error("kakaotalk owner arm missing");
    const runtime = arm.create(CREDENTIALS, SEND_ONLY, noopPublish, injectedOptions());
    if (runtime.deliveryRoute === undefined || runtime.typingRoute === undefined)
      throw new Error("kakaotalk owner arm mounts no routes");
    await runtime.surface.start("boot");
    expect(await runtime.deliveryRoute("2002", Outbound.payload("as the Owner"), "k-1", { channelId: "chat-group" })).toEqual({
      value: "accepted",
      externalMessageId: "log-1",
    });
    expect(runtime.typingRoute.everyMs).toBe(8_000);
    expect(await runtime.typingRoute.open("2002", { channelId: "chat-group" })).toEqual({ channelId: "chat-group" });
    await runtime.typingRoute.pulse({ channelId: "chat-group" });
    expect(owner.client.of("sendTyping").map((call) => call.args)).toEqual([["chat-group"]]);
  });

  it("the production seam builds the SDK's client and push listener without any I/O", () => {
    const seam = kakaoTalkOwnerSdk();
    const client = seam.client();
    expect(seam.listener(client)).toBeDefined();
  });
});

it("#1600: a KakaoTalk Owner instance names its account from the declaration", async () => {
  const { adapter } = await started();
  expect(adapter.account()).toEqual({ externalId: "1001" });
});
