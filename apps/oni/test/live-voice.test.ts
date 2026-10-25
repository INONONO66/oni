import { afterEach, expect, test } from "bun:test";
import { Core } from "@oni/agent";
import { VoiceJoinRefused, type PcmVoiceHandle, type ProviderVoiceRoute } from "@oni/channels";
import { TransportFailure, type Realtime, type RealtimeEvent, type RealtimeToolCall } from "@oni/llm";
import type { PlainValue, Tool } from "@oni/protocol";
import { Effect, Queue, Stream } from "effect";
import { z } from "zod";
import { createUpsampler } from "../src/composition/live-pcm";
import { createLiveVoice, type CallEndReason } from "../src/composition/live-voice";
import { bindSessionToolTurn, createSessionLivePlane } from "../src/composition/cluster-runtime";
import { createSendMessageTool } from "../src/bundles/messaging/send-message/index";
import { compiledPolicy } from "../../../packages/agent/test/helpers/compiled-policy";
import { toolTurnWorld } from "../../../packages/agent/test/helpers/tool-turn";
import { bounded } from "./helpers/protected-dispatch";
import { acquireSyncEffect, closeAcquiredEffects, runAbortableEffect, runEffect, runSyncEffect } from "./helpers/effect";
import { testPlane } from "./helpers/ledger";

const cleanups: (() => Promise<void>)[] = [];
const planes: ReturnType<typeof testPlane>[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  await closeAcquiredEffects();
  for (const plane of planes.splice(0)) plane.close();
});

const target = { kind: "contact", id: "person:owner", surface: "discord:bot", conversation: { channelId: "voice" } } as const;
const request = { to: target, kind: "call" as const };

function fixture(deny = false, failRealtime = false, toolWaitMs = 5_000, failResponse = false, opening?: Promise<void>, modelPcm = new Uint8Array([1, 0]), surface = "discord:bot") {
  const plane = testPlane();
  planes.push(plane);
  plane.stores.persons.put({
    id: "person:owner", displayName: "Owner", kind: "human", trustTier: "owner",
    endpoints: [{ channel: surface.split(":")[0] ?? surface, externalId: surface === "slack:owner" ? "T1:U-owner" : "owner-user" }],
    revision: 0, createdBy: "owner", updatedAt: 1,
  });
  const sessionId = crypto.randomUUID();
  const kernel = plane.openKernel(sessionId);
  const inbound = runSyncEffect(Queue.unbounded<Uint8Array>());
  const voiceEvents = runSyncEffect(Queue.unbounded<(PcmVoiceHandle["events"] extends AsyncIterable<infer E> ? E : never) | null>());
  const calls = runSyncEffect(Queue.unbounded<RealtimeToolCall>());
  const events = runSyncEffect(Queue.unbounded<RealtimeEvent | null>());
  const answeredCalls = runSyncEffect(Queue.unbounded<string>());
  const pulledCalls = runSyncEffect(Queue.unbounded<string>());
  const outputs: Uint8Array[] = [];
  const responses: { id: string; value: PlainValue }[] = [];
  const outcomes: { sessionId: string; call: string; reason: CallEndReason; releaseFailure?: string }[] = [];
  const incidents: { message: string; error: string }[] = [];
  const joined = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const audioWritten = Promise.withResolvers<void>();
  const leaveStarted = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const speech = Promise.withResolvers<void>();
  const capturedSpeech: Uint8Array[] = [];
  let leaves = 0;
  let closes = 0;
  let bodyCalls = 0;
  let failLeave = false;
  let failEnd = false;
  let holdLeave: Promise<void> | undefined;
  const handle: PcmVoiceHandle = {
    pcmIn: Stream.toAsyncIterable(Stream.fromQueue(inbound)),
    pcmOut: { write: async (pcm) => { outputs.push(pcm); audioWritten.resolve(); } },
    events: Stream.toAsyncIterable(Stream.fromQueue(voiceEvents).pipe(Stream.takeWhile((event) => event !== null))),
    leave: async () => {
      leaves += 1;
      leaveStarted.resolve();
      await holdLeave;
      await runEffect(Queue.shutdown(inbound));
      await runEffect(Queue.shutdown(voiceEvents));
      if (failLeave) throw new Error("voice release refused");
    },
  };
  const routeInputs: Parameters<ProviderVoiceRoute>[0][] = [];
  const routes = new Map<string, ProviderVoiceRoute>([[surface, async (input) => {
    routeInputs.push(input);
    joined.resolve();
    return handle;
  }]]);
  const realtime: Realtime = {
    open: ({ audioIn, audioOut }) => failRealtime
      ? Effect.fail(new TransportFailure({ operation: "realtime.socket", message: "handshake rejected", cause: "rejected" }))
      : Effect.promise(() => opening ?? Promise.resolve()).pipe(Effect.andThen(Effect.acquireRelease(
      Effect.succeed({
        toolCalls: Stream.fromQueue(calls).pipe(Stream.tap((call) => Queue.offer(pulledCalls, call.callId))),
        events: Stream.fromQueue(events).pipe(Stream.takeWhile((event) => event !== null)),
        respondTool: (id: string, value: PlainValue) => Effect.sync(() => {
          responses.push({ id, value });
          answered.resolve();
        }).pipe(Effect.andThen(Queue.offer(answeredCalls, id)), Effect.andThen(failResponse
          ? Effect.fail(new TransportFailure({ operation: "realtime.socket", message: "response rejected", cause: "closed" }))
          : Effect.void)),
      }),
      () => Effect.sync(() => { closes += 1; }),
    ).pipe(
      Effect.tap(() => Effect.forkScoped(Stream.runForEach(audioIn, (pcm) => Effect.sync(() => {
        capturedSpeech.push(pcm);
        speech.resolve();
      })))),
      Effect.tap(() => Effect.forkScoped(audioOut(modelPcm))),
    ))),
  };
  let world: Effect.Success<ReturnType<typeof toolTurnWorld>>;
  const driver = createLiveVoice({
    routes, realtime, persons: plane.stores.persons,
    role: (id) => id === sessionId ? "resident" : "child",
    id: () => "call-1",
    run: (effect, signal) => signal === undefined ? runEffect(effect) : runAbortableEffect(effect, signal),
    executeTool: (_id, input) => world.tool({ ...input, waitMs: toolWaitMs }),
    incident: (message, error) => { incidents.push({ message, error: String(error) }); },
    ended: (end) => {
      outcomes.push(end);
      ended.resolve();
      if (failEnd) throw new Error("end callback failed");
    },
  });
  const nested = Core.defineTool({
    name: "probe", category: "query", description: "Probe",
    input: z.object({ n: z.number() }), output: z.object({ n: z.number() }),
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: async (input) => { bodyCalls += 1; return input; },
    render: (_input, result) => JSON.stringify(result),
  });
  const send = createSendMessageTool(undefined, () => 1, { call: driver.call });
  const policy = compiledPolicy(deny ? [{
    name: "deny-live-probe", kind: "tool", phase: "pre",
    match: { encodingVersion: 1, value: { op: "probe" } },
    verdict: { encodingVersion: 1, value: { type: "deny", reason: "live_probe_denied" } },
    priority: 1, generation: 1,
  }] : []);
  world = acquireSyncEffect(toolTurnWorld({ plane, sessionId, definitions: [send, nested], policy }));
  const turns = runSyncEffect(world.plane.runtime(world.runtime).turns.pipe(Effect.provide(world.context)));
  const runTool = bindSessionToolTurn(turns, world.runtime, world.handle.scope, createSessionLivePlane());
  Object.assign(world.handle.env.ports, { runTool });
  cleanups.push(async () => { await driver.endAll("shutdown"); });
  const execute = async (value: Parameters<typeof send.execute>[0] = request) => {
    let receipt: Tool.Result | undefined;
    world.run((input) => world.execute(input, { id: "send-call", tool: "send_message", input: value }).pipe(
      Effect.map((result) => {
        receipt = result;
        return { kind: "result" as const, text: "" };
      }),
    ));
    await runEffect(world.prompt());
    await runEffect(world.settled);
    if (receipt === undefined) throw new Error("send_message did not settle");
    return receipt;
  };
  return {
    plane, kernel, world, sessionId, execute, driver, routes, routeInputs, inbound, voiceEvents, calls, events, answeredCalls, pulledCalls,
    joined: joined.promise, answered: answered.promise, audioWritten: audioWritten.promise, leaveStarted: leaveStarted.promise, ended: ended.promise,
    speech: speech.promise, capturedSpeech, responses, outputs, outcomes, incidents,
    leaves: () => leaves, closes: () => closes, bodyCalls: () => bodyCalls,
    usesAppDispatcher: () => world.handle.env.ports.runTool === runTool,
    rejectLeave: () => { failLeave = true; },
    rejectEnd: () => { failEnd = true; },
    holdLeave: (pending: Promise<void>) => { holdLeave = pending; },
  };
}

test.each([false, true])("a Slack Owner call retains its complete speaker id and %s gate decision", async (deny) => {
  const f = fixture(deny, false, 5_000, false, undefined, new Uint8Array([1, 0]), "slack:owner");
  const receipt = await bounded(f.execute({
    to: { kind: "contact", id: "person:owner", surface: "slack:owner", conversation: { channelId: "C1" } },
    kind: "call", message: "answer briefly",
  }));
  expect(receipt.isError).toBeUndefined();
  expect(f.routeInputs).toMatchObject([{
    surface: "slack:owner", channelId: "C1", speakerExternalId: "T1:U-owner",
  }]);
  await runEffect(Queue.offer(f.calls, { callId: "probe-slack", name: "probe", arguments: { n: 7 } }));
  await bounded(f.answered);
  expect(f.responses).toEqual([{
    id: "probe-slack", value: deny ? { error: "probe refused: live_probe_denied" } : { n: 7 },
  }]);
  expect(f.bodyCalls()).toBe(deny ? 0 : 1);
  await runEffect(Queue.offer(f.voiceEvents, { type: "speaker_left", externalId: "T1:U-owner" }));
  await bounded(f.ended);
  expect(f.outcomes[0]?.reason).toBe("owner_left");
  expect(f.leaves()).toBe(1);
  expect(f.closes()).toBe(1);
});

test("a completed Resident turn admits a later tool in a separate gated turn", async () => {
  const f = fixture();
  const receipt = await bounded(f.execute());
  expect(receipt.isError).toBeUndefined();
  await bounded(f.joined);
  const original = f.kernel.latestTurnTerminal(f.sessionId);
  expect(original?.effect.kind).toBe("result");
  const pending = f.calls;
  await runEffect(Queue.offer(pending, { callId: "tool-1", name: "probe", arguments: { n: 7 } }));
  await bounded(f.answered);
  expect(f.responses).toEqual([{ id: "tool-1", value: { n: 7 } }]);
  expect(f.bodyCalls()).toBe(1);
  expect(f.usesAppDispatcher()).toBe(true);
  const actions = f.kernel.historyPage(f.sessionId, { afterRevision: 0 }).actions;
  const tool = actions.filter((row) => row.kind === "tool" && z.object({ op: z.literal("probe"), phase: z.string() }).safeParse(row.intent.value).success);
  expect(tool.filter((row) => z.object({ phase: z.literal("intent") }).safeParse(row.intent.value).success)).toHaveLength(1);
  expect(tool.filter((row) => z.object({ phase: z.literal("result") }).safeParse(row.intent.value).success)).toHaveLength(1);
  const intent = tool.find((row) => z.object({ phase: z.literal("intent") }).safeParse(row.intent.value).success);
  expect(intent?.ordinal).toBeGreaterThan(original?.action.ordinal ?? 0);
  expect(intent?.parentId).not.toBe(original?.effect.turnId);
  expect(actions.filter((row) => row.kind === "turn" &&
    z.object({ phase: z.literal("terminal") }).safeParse(row.effect.value).success)).toHaveLength(2);
  expect(actions.some((row) => row.kind === "policy.decision" &&
    z.object({ hook: z.literal("tool.pre"), verdict: z.literal("allow") }).safeParse(row.intent.value).success)).toBe(true);
  await f.driver.end(f.sessionId, "interrupted");
  expect(f.leaves()).toBe(1);
  expect(f.closes()).toBe(1);
  expect(f.incidents).toEqual([]);
});

test("a denied realtime tool is answered once and never runs its body", async () => {
  const f = fixture(true);
  await bounded(f.execute());
  await runEffect(Queue.offer(f.calls, { callId: "denied", name: "probe", arguments: { n: 7 } }));
  await bounded(f.answered);
  expect(f.responses).toHaveLength(1);
  expect(f.responses[0]).toEqual({ id: "denied", value: { error: "probe refused: live_probe_denied" } });
  expect(f.bodyCalls()).toBe(0);
  await f.driver.end(f.sessionId, "interrupted");
});

test("a busy session answers the realtime model once without an inner tool intent", async () => {
  const f = fixture(false, false, 0);
  await f.execute();
  const entered = Promise.withResolvers<void>();
  f.world.run(() => Effect.sync(entered.resolve).pipe(Effect.andThen(Effect.never)));
  await runEffect(f.world.prompt());
  await bounded(entered.promise);
  const revision = f.kernel.row(f.sessionId).revision;
  await runEffect(Queue.offer(f.calls, { callId: "busy", name: "probe", arguments: { n: 3 } }));
  await bounded(f.answered);
  expect(f.responses).toEqual([{ id: "busy", value: { error: { code: "busy" } } }]);
  expect(f.bodyCalls()).toBe(0);
  expect(f.kernel.row(f.sessionId).revision).toBe(revision);
  await f.driver.endAll("shutdown");
});

test("realtime calls settle in arrival order with one response each", async () => {
  const f = fixture();
  await f.execute();
  await runEffect(Queue.offerAll(f.calls, [
    { callId: "first", name: "probe", arguments: { n: 1 } },
    { callId: "second", name: "probe", arguments: { n: 2 } },
  ]));
  expect(await bounded(runEffect(Queue.take(f.answeredCalls)))).toBe("first");
  expect(await bounded(runEffect(Queue.take(f.answeredCalls)))).toBe("second");
  expect(f.responses).toEqual([
    { id: "first", value: { n: 1 } }, { id: "second", value: { n: 2 } },
  ]);
  expect(f.bodyCalls()).toBe(2);
  await f.driver.endAll("shutdown");
});

test("a failed tool response is not sent a second time and releases both endpoints", async () => {
  const f = fixture(false, false, 5_000, true);
  await f.execute();
  await runEffect(Queue.offer(f.calls, { callId: "broken", name: "probe", arguments: { n: 4 } }));
  await bounded(f.ended);
  expect(f.responses).toEqual([{ id: "broken", value: { n: 4 } }]);
  expect(f.leaves()).toBe(1);
  expect(f.closes()).toBe(1);
});

test("the call releases both scopes when voice leave fails, and end is idempotent", async () => {
  const f = fixture();
  await bounded(f.execute());
  f.rejectLeave();
  await f.driver.end(f.sessionId, "shutdown");
  await f.driver.end(f.sessionId, "shutdown");
  expect(f.leaves()).toBe(1);
  expect(f.closes()).toBe(1);
  expect(f.outcomes).toEqual([{ sessionId: f.sessionId, call: "call-1", reason: "shutdown", releaseFailure: "Error: voice release refused" }]);
  expect(f.incidents).toEqual([{ message: "live call call-1 release failed", error: "Error: Error: voice release refused" }]);
});

test("interrupt is a no-op when the session has no live call", async () => {
  const f = fixture();
  await runEffect(f.driver.interrupt(f.sessionId));
  expect(f.outcomes).toEqual([]);
});

test("interrupt ends a live call with an interrupted outcome", async () => {
  const f = fixture();
  await bounded(f.execute());
  await runEffect(f.driver.interrupt(f.sessionId));
  expect(f.outcomes[0]?.reason).toBe("interrupted");
  expect(f.leaves()).toBe(1);
  expect(f.closes()).toBe(1);
});

test("interrupt maps an end rejection to the typed call failure", async () => {
  const f = fixture();
  await bounded(f.execute());
  f.rejectEnd();
  expect(await runEffect(Effect.flip(f.driver.interrupt(f.sessionId)))).toMatchObject({
    _tag: "AgentFailure", operation: "call.interrupt", cause: "Error: end callback failed",
  });
});

test.each([
  ["owner_left", (f: ReturnType<typeof fixture>) => Queue.offer(f.voiceEvents, { type: "speaker_left", externalId: "owner-user" })],
  ["voice_disconnected", (f: ReturnType<typeof fixture>) => Queue.offer(f.voiceEvents, { type: "disconnected", reason: "left" })],
  ["voice_error", (f: ReturnType<typeof fixture>) => Queue.offer(f.voiceEvents, { type: "error", reason: "bad voice" })],
  ["realtime_closed", (f: ReturnType<typeof fixture>) => Queue.offer(f.events, { type: "closed", reason: "limit" })],
  ["realtime_error", (f: ReturnType<typeof fixture>) => Queue.offer(f.events, { type: "error", reason: "socket" })],
] as const)("a %s event ends the call and releases both scopes", async (reason, send) => {
  const f = fixture();
  await bounded(f.execute());
  await runEffect(send(f));
  await bounded(f.ended);
  expect(f.outcomes[0]?.reason).toBe(reason);
  expect(f.leaves()).toBe(1);
  expect(f.closes()).toBe(1);
});

test.each(["voice", "realtime"] as const)("ending the %s event stream releases both endpoints", async (source) => {
  const f = fixture();
  await bounded(f.execute());
  if (source === "voice") await runEffect(Queue.offer(f.voiceEvents, null));
  else await runEffect(Queue.offer(f.events, null));
  await bounded(f.ended);
  expect(f.outcomes[0]?.reason).toBe(source === "voice" ? "voice_disconnected" : "realtime_closed");
  expect(f.leaves()).toBe(1);
  expect(f.closes()).toBe(1);
});

test("a PCM frame split across input chunks reaches the realtime stream", async () => {
  const f = fixture();
  await bounded(f.execute());
  await runEffect(Queue.offer(f.voiceEvents, { type: "ready" }));
  await runEffect(Queue.offer(f.events, { type: "transcript", speaker: "user", text: "hello" }));
  await runEffect(Queue.offer(f.inbound, new Uint8Array([1, 0, 1])));
  await runEffect(Queue.offer(f.inbound, new Uint8Array([0, 2, 0, 2, 0])));
  await bounded(f.speech);
  expect(f.capturedSpeech.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(2);
  await bounded(f.audioWritten);
  expect(f.outputs[0]).toEqual(createUpsampler().push(new Uint8Array([1, 0])));
  await f.driver.endAll("shutdown");
});

test("model PCM reaches voice output with distinguishable ordered samples after filter startup", async () => {
  const waveform = new Uint8Array(256 * 2);
  const view = new DataView(waveform.buffer);
  for (let i = 0; i < 256; i++) view.setInt16(i * 2, i < 96 ? 12_000 : i < 176 ? -8_000 : 4_000, true);
  const f = fixture(false, false, 5_000, false, undefined, waveform);
  await bounded(f.execute());
  await bounded(f.audioWritten);
  const expected = createUpsampler().push(waveform);
  expect(f.outputs).toEqual([expected]);
  expect(Array.from(expected.subarray(512, 768)).some((sample) => sample !== 0)).toBe(true);
  await f.driver.endAll("shutdown");
});

test("stopping closes tool admission before a held voice leave settles", async () => {
  const f = fixture();
  await bounded(f.execute());
  const leave = Promise.withResolvers<void>();
  f.holdLeave(leave.promise);
  const stopping = f.driver.end(f.sessionId, "shutdown");
  try {
    await bounded(f.leaveStarted);
    await runEffect(Queue.offer(f.calls, { callId: "after-stop", name: "probe", arguments: { n: 5 } }));
    expect(f.bodyCalls()).toBe(0);
  } finally {
    leave.resolve();
    await bounded(stopping);
  }
  expect(f.bodyCalls()).toBe(0);
});

test("the Owner leaving closes tool admission before a held voice leave settles", async () => {
  const f = fixture();
  await bounded(f.execute());
  const leave = Promise.withResolvers<void>();
  f.holdLeave(leave.promise);
  try {
    await runEffect(Queue.offer(f.voiceEvents, { type: "speaker_left", externalId: "owner-user" }));
    await bounded(f.leaveStarted);
    // The tool stream pulls the barrier only after it has fully dispatched the call before it.
    for (const callId of ["after-departure", "barrier"]) {
      await runEffect(Queue.offer(f.calls, { callId, name: "probe", arguments: { n: 91 } }));
      expect(await bounded(runEffect(Queue.take(f.pulledCalls)))).toBe(callId);
    }
    expect(f.bodyCalls()).toBe(0);
    expect(f.responses).toEqual([]);
  } finally {
    leave.resolve();
    await bounded(f.ended);
  }
  expect(f.outcomes[0]?.reason).toBe("owner_left");
  expect(f.bodyCalls()).toBe(0);
});

test.each([
  ["owner_left", { type: "speaker_left", externalId: "owner-user" }],
  ["voice_disconnected", { type: "disconnected", reason: "dropped" }],
  ["voice_error", { type: "error", reason: "device" }],
] as const)("%s during realtime acquisition refuses the joined receipt and releases voice", async (reason, event) => {
  const handshake = Promise.withResolvers<void>();
  const f = fixture(false, false, 5_000, false, handshake.promise);
  const receipt = f.execute();
  await bounded(f.joined);
  try {
    await runEffect(Queue.offer(f.voiceEvents, event));
    expect((await bounded(receipt)).isError).toBe(true);
    await bounded(f.ended);
    expect(f.outcomes[0]?.reason).toBe(reason);
    expect(f.leaves()).toBe(1);
  } finally {
    handshake.resolve();
  }
});

test("join refusal and realtime failure do not return a joined receipt", async () => {
  const f = fixture();
  f.routes.set("discord:bot", async () => { throw new VoiceJoinRefused({ reason: "join_failed", surface: "discord:bot", detail: "no permission" }); });
  expect((await bounded(f.execute())).isError).toBe(true);
  const broken = fixture();
  broken.routes.set("discord:bot", async () => { throw new Error("gateway closed"); });
  expect((await bounded(broken.execute())).isError).toBe(true);
  const denied = fixture(false, true);
  expect((await bounded(denied.execute())).isError).toBe(true);
  await bounded(denied.ended);
  expect(denied.leaves()).toBe(1);
});

test("a second call in one session is refused as busy", async () => {
  const f = fixture();
  await bounded(f.execute());
  await expect(f.driver.call.start({
    contact: "person:owner", surface: "discord:bot", channelId: "voice",
    sessionId: f.sessionId, turnId: "turn",
  })).rejects.toThrow("call_busy:");
  await f.driver.endAll("shutdown");
});

test("call schema admits an opening without a reaction and preserves ordinary send exclusivity", () => {
  const tool = createSendMessageTool(undefined, () => 1);
  expect(tool.input.safeParse({ ...request, message: "please help" }).success).toBe(true);
  expect(tool.input.safeParse({ ...request, react: "hi" }).success).toBe(false);
  expect(tool.input.safeParse({ to: target, message: "hello", react: "hi" }).success).toBe(false);
  expect(tool.input.safeParse({ to: target }).success).toBe(false);
});

test("call target, owner identity and port refusals precede gateway ingestion", async () => {
  const tool = createSendMessageTool(undefined, () => 1);
  const context = { sessionId: "resident", turnId: "turn", callId: "call", signal: new AbortController().signal };
  await expect(tool.execute({ ...request, to: { kind: "session", id: "other" } }, context))
    .rejects.toThrow("call_target:");
  await expect(tool.execute({ ...request, to: { ...target, as: "owner" } }, context))
    .rejects.toThrow("call_as_owner:");
  await expect(tool.execute(request, context))
    .rejects.toThrow("call_unavailable:");
});

test("child and non-Owner calls are refused before any voice join", async () => {
  const f = fixture();
  await expect(f.driver.call.start({
    contact: "person:owner", surface: "discord:bot", channelId: "voice", sessionId: "child", turnId: "turn",
  })).rejects.toThrow("call_child:");
  await expect(f.driver.call.start({
    contact: "person:missing", surface: "discord:bot", channelId: "voice", sessionId: f.sessionId, turnId: "turn",
  })).rejects.toThrow("call_not_owner:");
  await expect(f.driver.call.start({
    contact: "person:owner", surface: "slack:bot", channelId: "voice", sessionId: f.sessionId, turnId: "turn",
  })).rejects.toThrow("call_owner_unreachable:");
  f.routes.delete("discord:bot");
  await expect(f.driver.call.start({
    contact: "person:owner", surface: "discord:bot", channelId: "voice", sessionId: f.sessionId, turnId: "turn",
  })).rejects.toThrow("call_unrouted:");
});
