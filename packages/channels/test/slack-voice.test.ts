import { expect, test } from "bun:test";
import { Operational } from "@oni/protocol";
import { z } from "zod";
import { VoiceJoinRefused } from "../src/errors";
import { SlackOwnerAdapter } from "../src/provider/slack/owner";
import { SlackHuddleError } from "../src/provider/slack/owner-sdk";
import { FakeSlackOwnerListener, fakeHuddle, fakeSlackOwnerSdk, type HuddleEvent } from "./helpers/slack-owner-sdk";
import { inboundQueue } from "./helpers/inbound-queue";
import { injectedOptions } from "./helpers/injected";
import { bounded } from "./helpers/bounded";
import { testClockRuntime } from "./helpers/effect";

const credential = { token: "xoxc-owner", cookie: "owner-cookie" };
const address = { surface: "slack:owner", channelId: "C1", speakerExternalId: "T1:U-owner" };
const posture = { intake: "all" as const, autoReply: false };

function fixture(intake: "all" | "mentions_and_dms" | "none" = "all", run = injectedOptions().run) {
  const fake = fakeSlackOwnerSdk();
  const warning = Promise.withResolvers<string>();
  const adapter = new SlackOwnerAdapter(credential, { ...posture, intake }, (event, data) => {
    if (event.name === Operational.Events.Warn.name)
      warning.resolve(z.object({ msg: z.string() }).parse(data).msg);
  }, injectedOptions(run), fake.sdk);
  const queue = inboundQueue(adapter);
  const changed = (ts: string, room = "R1", user = "U-owner", team = "T1") => {
    fake.listener.emit("user_huddle_changed", {
      type: "user_huddle_changed", user: {
        id: user, team_id: team, profile: { huddle_state: "in_a_huddle", huddle_state_call_id: room },
      }, event_ts: ts,
    });
  };
  const room = (id = "R1", channel = "C1") => fake.listener.emit("sh_room_join", {
    type: "sh_room_join", user: "U-owner", room: { id, has_ended: false, participants: ["U-owner"] },
    huddle: { channel_id: channel }, event_ts: "10.0",
  });
  return { ...fake, adapter, ...queue, changed, room, warning: warning.promise };
}

async function expectNextResolvedRoom(f: ReturnType<typeof fixture>): Promise<void> {
  f.room("R2", "C2");
  const next = f.next();
  f.changed("1700.2", "R2");
  expect((await next).facts.channelId).toBe("C2");
  expect(f.inbound).toHaveLength(1);
}

async function acceptedEntry(f: ReturnType<typeof fixture>): Promise<void> {
  await f.adapter.start("start");
  f.room();
  const first = f.next();
  f.changed("1700.1");
  await first;
}

test("voice rejects malformed addresses and an unstarted arm before SDK I/O", async () => {
  const f = fixture();
  await expect(f.adapter.joinVoice(address)).rejects.toMatchObject({ _tag: "VoiceJoinRefused", reason: "not_started" });
  await f.adapter.start("start");
  for (const bad of [
    { ...address, surface: "slack:bot" },
    { ...address, speakerExternalId: "U-owner" },
    { ...address, speakerExternalId: "T2:U-owner" },
    { ...address, workspaceId: "T2" },
    { ...address, channelId: "R1" },
    { ...address, channelId: "" },
  ]) {
    await expect(f.adapter.joinVoice(bad)).rejects.toMatchObject({ _tag: "VoiceJoinRefused", reason: "address_incomplete" });
  }
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(f.adapter.joinVoice({ ...address, signal: cancelled.signal }))
    .rejects.toMatchObject({ _tag: "VoiceJoinRefused", reason: "aborted" });
  expect(f.joins).toEqual([]);
  await f.adapter.stop("stop");
});

test("a ready call passes the Owner session, maps departure once, and releases its reservation", async () => {
  const f = fixture("none");
  const h = fakeHuddle();
  f.setJoin(async () => h.handle);
  await f.adapter.start("start");
  const voice = await f.adapter.joinVoice(address);
  expect(f.joins).toEqual([{
    workspaceId: "T1", channelId: "C1", speakerId: "U-owner", credentials: credential,
  }]);
  const events = voice.events[Symbol.asyncIterator]();
  h.emit({ type: "ready" });
  expect((await bounded(events.next())).value).toEqual({ type: "ready" });
  h.emit({ type: "speaker_left", userId: "U-owner" });
  expect((await bounded(events.next())).value).toEqual({ type: "speaker_left", externalId: "T1:U-owner" });
  await voice.leave();
  expect(h.leaves).toBe(1);
  const next = fakeHuddle();
  f.setJoin(async () => next.handle);
  await (await f.adapter.joinVoice(address)).leave();
  await f.adapter.stop("stop");
});

test("a failed fork event iterator emits a safe error and releases the active seat", async () => {
  const f = fixture("none");
  const h = fakeHuddle();
  f.setJoin(async () => ({
    ...h.handle,
    events: (async function* (): AsyncGenerator<HuddleEvent, void, void> {
      yield { type: "ready" as const };
      throw new Error("secret browser URL");
    })(),
  }));
  await f.adapter.start("start");
  const voice = await f.adapter.joinVoice(address);
  const events = voice.events[Symbol.asyncIterator]();
  expect((await bounded(events.next())).value).toEqual({ type: "ready" });
  expect((await bounded(events.next())).value).toEqual({
    type: "error", reason: "voice_event_failed",
  });
  f.setJoin(async () => fakeHuddle().handle);
  await (await f.adapter.joinVoice(address)).leave();
  await f.adapter.stop("stop");
});

test("stop retains terminal handle custody until cleanup settles", async () => {
  const f = fixture("none");
  const h = fakeHuddle();
  const cleanup = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  f.setJoin(async () => ({
    ...h.handle,
    events: (async function* (): AsyncGenerator<HuddleEvent, void, void> {
      yield { type: "disconnected" as const, reason: "room_closed" };
    })(),
    leave: async () => {
      entered.resolve();
      await cleanup.promise;
      await h.handle.leave();
    },
  }));
  await f.adapter.start("start");
  const voice = await f.adapter.joinVoice(address);
  const events = voice.events[Symbol.asyncIterator]();
  const terminal = await bounded(events.next());
  expect(terminal.value).toEqual({ type: "disconnected", reason: "room_closed" });
  expect((await bounded(events.next())).done).toBe(true);
  let stopped = false;
  const stopping = f.adapter.stop("stop").then(() => { stopped = true; });
  const first = await bounded(Promise.race([entered.promise.then(() => "cleanup"), stopping.then(() => "stop")]));
  expect(first).toBe("cleanup");
  expect(stopped).toBe(false);
  expect(h.leaves).toBe(0);
  cleanup.resolve();
  await bounded(stopping);
  expect(h.leaves).toBe(1);
});

test("untrusted fork descriptions never expose a URL, cookie or response body", async () => {
  const f = fixture("none");
  f.setJoin(async () => { throw new SlackHuddleError("voice_join_failed", "https://secret.test/?cookie=d"); });
  await f.adapter.start("start");
  await expect(f.adapter.joinVoice(address)).rejects.toMatchObject({
    reason: "join_failed", detail: "voice_join_failed",
  });
  const h = fakeHuddle();
  f.setJoin(async () => h.handle);
  const voice = await f.adapter.joinVoice(address);
  h.emit({ type: "disconnected", reason: "cookie=d; https://secret.test/" });
  expect((await bounded(voice.events[Symbol.asyncIterator]().next())).value).toEqual({
    type: "disconnected", reason: "voice_disconnected",
  });
  await voice.leave();
  await f.adapter.stop("stop");
});

test.each([
  ["voice_not_ready", "not_started"],
  ["voice_busy", "busy"],
  ["voice_aborted", "aborted"],
  ["voice_join_failed", "join_failed"],
] as const)("the SDK %s refusal is mapped to %s without leaking content", async (code, reason) => {
  const f = fixture("none");
  f.setJoin(async () => { throw new SlackHuddleError(code, "workspace_mismatch"); });
  await f.adapter.start("start");
  await expect(f.adapter.joinVoice(address)).rejects.toMatchObject({
    _tag: "VoiceJoinRefused", reason, detail: "workspace_mismatch",
  });
  await f.adapter.stop("stop");
});

test("one pending call is busy, stop aborts it and cleans a late raw handle", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const resolve = Promise.withResolvers<ReturnType<typeof fakeHuddle>["handle"]>();
  f.setJoin(async () => { entered.resolve(); return resolve.promise; });
  await f.adapter.start("start");
  const pending = f.adapter.joinVoice(address);
  await bounded(entered.promise);
  await expect(f.adapter.joinVoice(address)).rejects.toMatchObject({ reason: "busy" });
  const stopped = f.adapter.stop("stop");
  f.room();
  f.changed("1700.1");
  expect(f.inbound).toEqual([]);
  const raw = fakeHuddle();
  resolve.resolve(raw.handle);
  await expect(pending).rejects.toBeInstanceOf(VoiceJoinRefused);
  await stopped;
  expect(raw.leaves).toBe(1);
});

test("voice refuses admission before the RTM hello", async () => {
  const entered = Promise.withResolvers<void>();
  const listener = new FakeSlackOwnerListener(() => entered.resolve());
  const fake = fakeSlackOwnerSdk({}, listener);
  const adapter = new SlackOwnerAdapter(credential, posture, () => undefined, injectedOptions(), fake.sdk);
  adapter.onMessage(() => Promise.resolve());
  fake.setJoin(async () => fakeHuddle().handle);
  const starting = adapter.start("start");
  await bounded(entered.promise);
  await expect(adapter.joinVoice(address)).rejects.toMatchObject({ _tag: "VoiceJoinRefused", reason: "not_started" });
  expect(fake.joins).toEqual([]);
  listener.emit("error", new Error("rtm_connect_failed"));
  await expect(starting).rejects.toThrow();
  await adapter.stop("stop");
});

test("stop fences authentication completing after teardown", async () => {
  const f = fixture("none");
  const entered = Promise.withResolvers<void>();
  const auth = Promise.withResolvers<{ user_id: string; team_id: string }>();
  f.client.testAuth = () => { entered.resolve(); return auth.promise; };
  const starting = f.adapter.start("start");
  await bounded(entered.promise);
  await f.adapter.stop("stop");
  auth.resolve({ user_id: "U-owner", team_id: "T1" });
  await expect(starting).rejects.toThrow();
  await expect(f.adapter.joinVoice(address)).rejects.toMatchObject({ _tag: "VoiceJoinRefused", reason: "not_started" });
  expect(f.joins).toEqual([]);
  expect(f.listener.started).toBe(0);
});

test("stop reports rejected late-handle cleanup and join maps the refusal", async () => {
  const f = fixture("none");
  const entered = Promise.withResolvers<void>();
  const raw = fakeHuddle();
  const resolved = Promise.withResolvers<typeof raw.handle>();
  f.setJoin(() => { entered.resolve(); return resolved.promise; });
  await f.adapter.start("start");
  const joining = f.adapter.joinVoice(address);
  await bounded(entered.promise);
  const stopped = f.adapter.stop("stop");
  const joinOutcome = joining.then(() => "joined", (error: VoiceJoinRefused) => error);
  const stopOutcome = stopped.then(() => "stopped", (error: VoiceJoinRefused) => error);
  resolved.resolve({
    ...raw.handle,
    leave: async () => {
      await raw.handle.leave();
      throw new SlackHuddleError("voice_join_failed", "cleanup_timeout");
    },
  });
  expect(await bounded(joinOutcome)).toMatchObject({
    _tag: "VoiceJoinRefused", reason: "join_failed", detail: "cleanup_timeout",
  });
  expect(await bounded(stopOutcome)).toMatchObject({
    _tag: "VoiceJoinRefused", reason: "join_failed", detail: "cleanup_timeout",
  });
  expect(raw.leaves).toBe(1);
});

test.each([null, undefined])("explicit leave with room id %s allows a newer same-room call", async (roomId) => {
  const f = fixture();
  await acceptedEntry(f);
  f.listener.emit("user_huddle_changed", {
    type: "user_huddle_changed", user: {
      id: "U-owner", team_id: "T1",
      profile: { huddle_state: "not_in_a_huddle", ...(roomId === undefined ? {} : { huddle_state_call_id: roomId }) },
    }, event_ts: "1700.2",
  });
  const next = f.next();
  f.changed("1700.3");
  expect((await next).facts.eventId).toBe("call:slack:T1:U-owner:1700.3:R1");
  expect(f.inbound.map((message) => message.facts.eventId)).toEqual([
    "call:slack:T1:U-owner:1700.1:R1", "call:slack:T1:U-owner:1700.3:R1",
  ]);
  await f.adapter.stop("stop");
});

test.each([false, true])("an old room conflict %s preserves the current pending association", async (conflict) => {
  const f = fixture();
  await f.adapter.start("start");
  f.room("R1", "C1");
  f.changed("1700.1", "R2");
  if (conflict) f.room("R1", "C3");
  const next = f.next();
  f.room("R2", "C2");
  expect((await next).facts.channelId).toBe("C2");
  expect(f.inbound.filter((message) => message.facts.event === "call")).toHaveLength(1);
  if (conflict) {
    f.changed("1700.2", "R1");
    expect(f.inbound.filter((message) => message.facts.event === "call")).toHaveLength(1);
  }
  await f.adapter.stop("stop");
});

test.each([["9.9", "10.0"], ["10.1", "11.0"]] as const)(
  "integer timestamp progression %s to %s admits the newer room and refuses stale updates",
  async (firstTs, secondTs) => {
    const f = fixture();
    await f.adapter.start("start");
    f.room("R1", "C1");
    f.room("R2", "C2");
    const first = f.next();
    f.changed(firstTs, "R1");
    expect((await first).facts.channelId).toBe("C1");
    f.changed(secondTs, "R2");
    f.changed(firstTs, "R1");
    const dispatched = f.next();
    f.listener.message({ channel: "D2", user: "U-other", text: "sentinel", ts: "1701.1" });
    await dispatched;
    expect(f.inbound.filter((message) => message.facts.event === "call").map((message) => message.facts.channelId))
      .toEqual(["C1", "C2"]);
    await f.adapter.stop("stop");
  },
);

test("Owner state resolves in either event order and never mistakes the room for a channel", async () => {
  const f = fixture();
  await f.adapter.start("start");
  const first = f.next();
  f.changed("1700.000001");
  f.room();
  expect((await first).facts).toMatchObject({
    event: "call", channelId: "C1", receivedBy: "owner", addressees: [],
  });
  const second = f.next();
  f.room("R2", "D2");
  f.changed("1700.000002", "R2");
  expect((await second).facts).toMatchObject({ event: "call", channelId: "D2", dm: true });
  await f.adapter.stop("stop");
});

test("conflicting room associations cannot produce a fabricated channel call", async () => {
  const f = fixture();
  await f.adapter.start("start");
  f.room("R1", "C1");
  f.room("R1", "C2");
  f.changed("1700.1");
  f.room("R1", "C1");
  await expectNextResolvedRoom(f);
  await f.adapter.stop("stop");
});

test("an RTM disconnect discards unresolved rooms before a reconnect", async () => {
  const f = fixture();
  await f.adapter.start("start");
  f.changed("1700.1", "R1");
  f.listener.emit("disconnected");
  f.room("R1", "C1");
  await expectNextResolvedRoom(f);
  await f.adapter.stop("stop");
});

test("reconnect preserves the last accepted same-room transition", async () => {
  const f = fixture();
  await acceptedEntry(f);
  f.listener.emit("disconnected");
  f.room();
  f.room("R2", "C2");
  f.changed("1700.05", "R2");
  f.changed("1700.2");
  expect(f.inbound.map((message) => message.facts.eventId)).toEqual([
    "call:slack:T1:U-owner:1700.1:R1",
  ]);
  await f.adapter.stop("stop");
});

test("an unknown state cannot reset a same-room transition", async () => {
  const f = fixture();
  await acceptedEntry(f);
  f.listener.emit("user_huddle_changed", {
    type: "user_huddle_changed", user: {
      id: "U-owner", team_id: "T1",
      profile: { huddle_state: "new_unknown_state", huddle_state_call_id: null },
    }, event_ts: "1700.2",
  });
  f.changed("1700.3");
  expect(f.inbound.map((message) => message.facts.eventId)).toEqual([
    "call:slack:T1:U-owner:1700.1:R1",
  ]);
  await f.adapter.stop("stop");
});

test("the 33rd conflict evicts the oldest of 32 room associations", async () => {
  const f = fixture();
  await f.adapter.start("start");
  for (let index = 1; index <= 32; index++) {
    f.room(`R${index}`, `C${index}`);
    f.room(`R${index}`, `D${index}`);
  }
  f.room("R32", "C32");
  f.changed("1700.1", "R32");
  f.room("R33", "C33");
  f.room("R33", "D33");
  f.room("R2", "C2");
  f.changed("1700.2", "R2");
  f.room("R1", "C1");
  f.changed("1700.3", "R1");
  const flushed = f.next();
  f.listener.message({ channel: "D2", user: "U-other", text: "flush", ts: "1701.1" });
  await flushed;
  f.room("R33", "C33");
  f.changed("1700.4", "R33");
  expect(f.inbound.filter((message) => message.facts.event === "call").map((message) => message.facts.channelId))
    .toEqual(["C1"]);
  await f.adapter.stop("stop");
});

test("an unresolved room emits a bounded warning and no fabricated call", async () => {
  const clock = testClockRuntime();
  const f = fixture("all", clock.run);
  try {
    await f.adapter.start("start");
    const warning = f.warning;
    f.changed("1700.1", "R1");
    await clock.adjust(10_000);
    expect(await bounded(warning)).toBe("huddle_channel_unresolved");
    expect(f.inbound).toEqual([]);
  } finally {
    await f.adapter.stop("stop");
    await clock.dispose();
  }
});

test("same-room updates, old timestamps, other users and the user_change twin emit no extra call", async () => {
  const f = fixture("mentions_and_dms");
  await f.adapter.start("start");
  f.room();
  const first = f.next();
  f.changed("1700.000002");
  await first;
  f.changed("1700.000002");
  f.changed("1700.000001", "R2");
  f.changed("1700.000003", "R2", "U-other");
  f.changed("1700.000004", "R2", "U-owner", "T2");
  f.listener.emit("slack_event", { type: "user_change" });
  const sentinel = f.next();
  f.listener.message({ channel: "D2", user: "U-other", text: "done", ts: "1701.1" });
  await sentinel;
  expect(f.inbound.map((message) => message.facts.event)).toEqual(["call", "message"]);
  await f.adapter.stop("stop");
});

test("Owner updates during pending and live calls advance state without echoing a trigger", async () => {
  const f = fixture();
  const joined = Promise.withResolvers<ReturnType<typeof fakeHuddle>["handle"]>();
  const entered = Promise.withResolvers<void>();
  f.setJoin(async () => { entered.resolve(); return joined.promise; });
  await f.adapter.start("start");
  f.room("R1");
  f.room("R2");
  f.room("R3");
  const call = f.adapter.joinVoice(address);
  await bounded(entered.promise);
  f.changed("1700.1", "R1");
  const h = fakeHuddle();
  joined.resolve(h.handle);
  const active = await call;
  f.changed("1700.2", "R2");
  await active.leave();
  const delivered = f.next();
  f.changed("1700.3", "R3");
  expect((await delivered).facts.eventId).toBe("call:slack:T1:U-owner:1700.3:R3");
  expect(f.inbound).toHaveLength(1);
  await f.adapter.stop("stop");
});

test("a room association arriving after an active call leaves cannot replay its suppressed transition", async () => {
  const f = fixture();
  const h = fakeHuddle();
  f.setJoin(async () => h.handle);
  await f.adapter.start("start");
  const voice = await f.adapter.joinVoice(address);
  f.changed("1700.1", "R1");
  await voice.leave();
  f.room("R1");
  f.room("R2");
  const next = f.next();
  f.changed("1700.2", "R2");
  expect((await next).facts.eventId).toBe("call:slack:T1:U-owner:1700.2:R2");
  expect(f.inbound).toHaveLength(1);
  await f.adapter.stop("stop");
});

test("intake none does not emit a passive trigger", async () => {
  const f = fixture("none");
  await f.adapter.start("start");
  f.changed("1700.1");
  f.room();
  expect(f.listener.started).toBe(0);
  expect(f.inbound).toEqual([]);
  await f.adapter.stop("stop");
});
