/**
 * #1255 P6 — the monitor BUNDLE through the composed app, end to end:
 *
 * 1. a cron chain armed through the real `monitor` tool survives a restart,
 *    and a boot past its due instant fires it exactly once — one firing in
 *    the alarms read model, one `prompt{origin: alarm}` in history, and NO
 *    spurious generation rotation (the recomposed manifest hashes identically,
 *    so the adopted generation number is stable across the restart);
 * 2. `provision{bundle_disable}` mid-turn: the running turn finishes on its
 *    captured generation (monitor still offered to the model), and the NEXT
 *    turn adopts the recomposed generation — new generation number, monitor
 *    gone from the bundle list and the tool table, the off cascade recorded
 *    in the compose configure's `disabled`;
 * 3. a bundle in `OPENOMNI_BUNDLES_OFF` at boot composes out through the real
 *    index.ts wiring: its tool face is never offered, the session's adopted
 *    bundles exclude it, and an unregistered input kind is refused
 *    `unknown_kind` at `deliver` with zero new facts.
 *
 * No fixed sleeps: every wait subscribes to the exact committed state change
 * (Bus ActionCommittedEvent) with a bounded timeout, and phase 1's "due time"
 * is the injected wall clock, never a timer.
 */
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import { Core } from "@openomni/agent";
import { newTraceId } from "./helpers/bus";
import { foldAlarmChains, watchStateOf } from "../src/bundles/alarms/index";
import { runAppEffect } from "../src/gateway";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { untilCommitted } from "./helpers/committed-state";
import { openResidentRequest } from "./helpers/open-resident-request";
import { planeOf } from "./helpers/ledger";
import { residentSuite, fakeProviderModel } from "./helpers/resident-suite";
import { nextFrame } from "./helpers/ws";
import type { AppLedgerPlane } from "../src/composition/cluster-runtime";

const suite = residentSuite();
const TOKEN = "bundle-test";

/** The `alarm{fired}` rows of one chain, in journal order. */
function firedOutcomes(plane: AppLedgerPlane, sessionId: string, alarmId: string) {
  return sessionTree(sessionId, plane.sessionStore(sessionId).actions)
    .filter((action) => action.kind === "alarm")
    .map((action) => action.intent.value as { op?: string; alarmId?: string; outcome?: string })
    .filter((value) => value.op === "fired" && value.alarmId === alarmId)
    .map((value) => value.outcome);
}

function residentSessionId(plane: AppLedgerPlane): string | undefined {
  return plane.listSessions().find((row) => row.id !== "gateway-ingress")?.id;
}

function lastTurnTerminal(plane: AppLedgerPlane, sessionId: string): string | undefined {
  return plane.openKernel(sessionId).getSnapshot(sessionId).turns.at(-1)?.terminal?.kind;
}

function alarmPrompts(plane: AppLedgerPlane, sessionId: string) {
  return sessionTree(sessionId, plane.sessionStore(sessionId).actions).filter((action) => {
    if (action.kind !== "prompt") return false;
    return (action.intent.value as { kind?: string }).kind === "alarm";
  });
}

// ─── 1. restart + past-due boot fires the persisted cron chain ──────────────

const T0 = Date.UTC(2026, 0, 1, 0, 0, 30);
const FIRST_FIRE = Date.UTC(2026, 0, 1, 0, 5, 0);
const SECOND_FIRE = Date.UTC(2026, 0, 1, 0, 10, 0);

test("a cron armed through the monitor tool survives restart; a past-due boot fires it once with no spurious rotation", async () => {
  const config = suite.config("monitor-bundle-restart-", {
    wsToken: TOKEN,
    compactionSummarizer: false,
  });
  let calls1 = 0;
  const app1 = await suite.boot({
    config,
    clusterClock: "injected",
    sessionRuntime: { clock: () => T0 },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls1 += 1;
        if (calls1 === 1)
          requestToolStep(input, sink, {
            id: "cron-create",
            tool: "monitor",
            input: {
              operation: {
                op: "create",
                description: "five minute grid",
                source: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
              },
            },
          });
        else sink.onMessage(assistantMessage(input, { text: "armed" }));
        return { type: "stop" as const };
      }),
    },
  });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app1.port}/ws`, ["auth", TOKEN]);
  const plane1 = await planeOf(app1.runtime);
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "arm the grid" }));
  await untilCommitted(() => {
    const sessionId = residentSessionId(plane1);
    return sessionId !== undefined && lastTurnTerminal(plane1, sessionId) === "waiting";
  }, "cron create did not suspend");
  const sessionId = residentSessionId(plane1);
  if (sessionId === undefined) throw new Error("no resident session");
  const kernel1 = plane1.openKernel(sessionId);
  const chains1 = [...foldAlarmChains(kernel1, sessionId).entries()];
  expect(chains1).toHaveLength(1);
  const [watchId, chain1] = chains1[0] ?? ["", undefined];
  if (chain1 === undefined) throw new Error("no armed chain");
  // The grid instant comes from the INJECTED clock: the next */5 boundary.
  expect(watchStateOf(chain1, sessionId)).toMatchObject({
    kind: "cron",
    status: "armed",
    notifications: 0,
    fireAt: FIRST_FIRE,
  });
  const generationBefore = kernel1.latestGenerationFor(sessionId);
  expect(generationBefore.manifestHash).toBeDefined();

  // The restart: stop the whole app and boot a second one past the due time
  // over the same durable state. The boot rescan wakes the session, the
  // persisted occurrence delivers (its DeliverAt instant is in the past), and
  // the composed cron purpose folds the firing + one alarm prompt + a re-arm.
  await app1.stop();
  let calls2 = 0;
  const app2 = await suite.boot({
    config,
    clusterClock: "injected",
    sessionRuntime: { clock: () => FIRST_FIRE + 1_000 },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls2 += 1;
        sink.onMessage(assistantMessage(input, { text: "observed the tick" }));
        return { type: "stop" as const };
      }),
    },
  });
  const plane2 = await planeOf(app2.runtime);
  await untilCommitted(
    () => lastTurnTerminal(plane2, sessionId) === "result",
    "past-due boot never fired the cron",
  );
  expect(calls2).toBe(1);
  // One firing in the alarms read model; the chain re-armed on the next grid instant.
  const kernel2 = plane2.openKernel(sessionId);
  const fired = foldAlarmChains(kernel2, sessionId).get(watchId);
  if (fired === undefined) throw new Error("chain lost across restart");
  expect(watchStateOf(fired, sessionId)).toMatchObject({
    kind: "cron",
    status: "armed",
    notifications: 1,
    fireAt: SECOND_FIRE,
  });
  // One prompt{origin: alarm} in history.
  const prompts = alarmPrompts(plane2, sessionId);
  expect(prompts).toHaveLength(1);
  expect((prompts[0]?.intent.value as { alarmId?: string }).alarmId).toBe(watchId);
  // No spurious rotation: the recomposed manifest hashes identically, so the
  // session kept its adopted generation across the restart (#1255 P3).
  const generationAfter = kernel2.latestGenerationFor(sessionId);
  expect(generationAfter.generation).toBe(generationBefore.generation);
  expect(generationAfter.manifestHash).toBe(generationBefore.manifestHash);
}, 40_000);

// ─── 2. provision bundle_disable mid-turn ───────────────────────────────────

test("bundle_disable mid-turn: the running turn keeps its captured generation; the next turn adopts the recompose", async () => {
  const toolsSeen: string[][] = [];
  let calls = 0;
  const app = await suite.boot({
    config: suite.config("monitor-bundle-disable-", {
      wsToken: TOKEN,
      compactionSummarizer: false,
    }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls += 1;
        toolsSeen.push(input.tools.map((tool) => tool.name));
        if (calls === 1)
          requestToolStep(input, sink, {
            id: "disable-monitor",
            tool: "provision",
            input: { operation: { op: "bundle_disable", args: { name: "monitor" } } },
          });
        else sink.onMessage(assistantMessage(input, { text: `turn ${calls} done` }));
        return { type: "stop" as const };
      }),
    },
  });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", TOKEN]);
  const plane = await planeOf(app.runtime);
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "disable the monitor bundle" }));
  // Owner consent: the composed consent row suspends the wave on an open request.
  const openRequest = () => openResidentRequest(plane, residentSessionId(plane));
  await untilCommitted(() => openRequest() !== undefined, "bundle_disable consent never opened");
  const request = openRequest();
  if (request === undefined) throw new Error("missing consent request");
  const sessionId = residentSessionId(plane);
  if (sessionId === undefined) throw new Error("no resident session");
  const generationBefore = plane.openKernel(sessionId).latestGenerationFor(sessionId);
  expect(toolsSeen[0]).toContain("monitor");
  // The authenticated Owner approves; the application recomposes and swaps.
  const answerId = newTraceId();
  const receipt = nextFrame(ws, (frame) => frame.type === "receipt" && frame.inputId === answerId);
  ws.send(
    JSON.stringify({
      type: "request_answer",
      inputId: answerId,
      request,
      decision: "approve",
      credential: TOKEN,
    }),
  );
  await receipt;
  await untilCommitted(
    () => lastTurnTerminal(plane, sessionId) === "result",
    "disable turn never finished",
  );
  // The RUNNING turn finished on its captured generation: the model's second
  // wave still saw the monitor tool, and no rotation happened mid-turn.
  expect(calls).toBe(2);
  expect(toolsSeen[1]).toContain("monitor");
  const kernel = plane.openKernel(sessionId);
  const generationMid = kernel.latestGenerationFor(sessionId);
  expect(generationMid.generation).toBe(generationBefore.generation);
  // The NEXT turn adopts: new generation number, monitor out of the bundle
  // list and the tool table, the off cascade recorded on the compose configure.
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "and now?" }));
  await untilCommitted(() => calls >= 3, "next turn never ran");
  await untilCommitted(
    () => lastTurnTerminal(plane, sessionId) === "result",
    "adopting turn never finished",
  );
  expect(toolsSeen[2]).not.toContain("monitor");
  const generationAfter = kernel.latestGenerationFor(sessionId);
  expect(generationAfter.generation).toBe(generationBefore.generation + 1);
  expect(generationAfter.bundles).not.toContain("monitor");
  expect(generationAfter.manifestHash).not.toBe(generationBefore.manifestHash);
  const composeConfigure = sessionTree(sessionId, plane.sessionStore(sessionId).actions).find(
    (action) =>
      action.kind === "session.configure" &&
      (action.intent.value as { operation?: string }).operation === "compose",
  );
  if (composeConfigure === undefined) throw new Error("no compose adoption configure");
  expect(
    (composeConfigure.intent.value as { disabled?: readonly { name: string }[] }).disabled?.map(
      (entry) => entry.name,
    ),
  ).toContain("monitor");
}, 40_000);

// ─── 3. off at boot through index.ts wiring ─────────────────────────────────

test("a bundle off at boot composes out: no tool face, no bundle adoption, unknown input kinds refuse with zero new facts", async () => {
  const toolsSeen: string[][] = [];
  const app = await suite.boot({
    config: suite.config("monitor-bundle-off-", {
      wsToken: TOKEN,
      compactionSummarizer: false,
      off: ["monitor"],
    }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        toolsSeen.push(input.tools.map((tool) => tool.name));
        sink.onMessage(assistantMessage(input, { text: "no monitor here" }));
        return { type: "stop" as const };
      }),
    },
  });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", TOKEN]);
  const plane = await planeOf(app.runtime);
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "what can you do?" }));
  await untilCommitted(() => {
    const sessionId = residentSessionId(plane);
    return sessionId !== undefined && lastTurnTerminal(plane, sessionId) === "result";
  }, "turn never finished");
  const sessionId = residentSessionId(plane);
  if (sessionId === undefined) throw new Error("no resident session");
  // The off bundle's tool face never reaches the model; the adopted bundles exclude it.
  expect(toolsSeen[0]).not.toContain("monitor");
  const generation = plane.openKernel(sessionId).latestGenerationFor(sessionId);
  expect(generation.bundles).not.toContain("monitor");
  expect(generation.tools.map((tool) => tool.name)).not.toContain("monitor");
  // An input kind nothing registered refuses `unknown_kind` at deliver with
  // zero new facts (the composed registrations are the only admission list).
  const before = sessionTree(sessionId, plane.sessionStore(sessionId).actions).length;
  const refusal = await runAppEffect(
    app.runtime,
    Effect.scoped(
      Effect.gen(function* () {
        const makeClient = yield* Core.SessionEntity.client;
        return yield* Effect.result(
          makeClient(sessionId).Deliver({
            kind: "monitor.feed",
            body: JSON.stringify({ content: "spurious" }),
            source: JSON.stringify({
              kind: "message",
              messageId: "off-probe",
              senderSessionId: sessionId,
              sourceActionId: "off-probe",
            }),
            idempotencyKey: "off-probe-1",
          }),
        );
      }),
    ),
  );
  expect(refusal).toMatchObject({ _tag: "Failure", failure: { code: "unknown_kind" } });
  expect(sessionTree(sessionId, plane.sessionStore(sessionId).actions)).toHaveLength(before);
}, 40_000);

// ─── 4. recompose re-routes alarm purposes (live capability follows the swap) ─

type StepInput = Parameters<typeof requestToolStep>[0];
type StepSink = Parameters<typeof requestToolStep>[1];
type Step = (input: StepInput, sink: StepSink) => void;

test("bundle_disable cron: a due tick folds fired{stale} with no prompt; bundle_enable restores arming and routing", async () => {
  // Clock the whole app (cluster DeliverAt holds included) from one mutable
  // instant; the test advances it instead of sleeping.
  let now = T0;
  const cronCreate = (id: string): Step => (input, sink) =>
    requestToolStep(input, sink, {
      id,
      tool: "monitor",
      input: {
        operation: {
          op: "create",
          description: "five minute grid",
          source: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        },
      },
    });
  const bundleOp = (op: "bundle_enable" | "bundle_disable"): Step => (input, sink) =>
    requestToolStep(input, sink, {
      id: `${op}-cron`,
      tool: "provision",
      input: { operation: { op, args: { name: "cron" } } },
    });
  // Scripted model: each wave consumes one step; an empty queue ends the wave.
  const steps: Step[] = [];
  let calls = 0;
  const app = await suite.boot({
    config: suite.config("monitor-bundle-reroute-", {
      wsToken: TOKEN,
      compactionSummarizer: false,
    }),
    clusterClock: "injected",
    sessionRuntime: { clock: () => now },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls += 1;
        const step = steps.shift();
        if (step === undefined) sink.onMessage(assistantMessage(input, { text: `wave ${calls}` }));
        else step(input, sink);
        return { type: "stop" as const };
      }),
    },
  });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", TOKEN]);
  const plane = await planeOf(app.runtime);
  const say = (text: string) => ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text }));
  const openRequest = (sessionId: string) =>
    plane.openKernel(sessionId).requestRows(sessionId).find((request) => request.state === "open");
  /** Owner consent for one provision op: wait for the open request, approve, wait for the turn. */
  const consent = async (sessionId: string, label: string) => {
    await untilCommitted(() => openRequest(sessionId) !== undefined, `${label} consent never opened`);
    const request = openRequest(sessionId);
    if (request === undefined) throw new Error(`${label}: missing consent request`);
    const inputId = newTraceId();
    const receipt = nextFrame(ws, (frame) => frame.type === "receipt" && frame.inputId === inputId);
    ws.send(
      JSON.stringify({ type: "request_answer", inputId, request, decision: "approve", credential: TOKEN }),
    );
    await receipt;
    await untilCommitted(() => lastTurnTerminal(plane, sessionId) === "result", `${label} turn never finished`);
  };

  // Arm a cron chain while cron is on; it holds on the injected FIRST_FIRE.
  steps.push(cronCreate("cron-create-1"));
  say("arm the grid");
  await untilCommitted(() => {
    const sessionId = residentSessionId(plane);
    return sessionId !== undefined && lastTurnTerminal(plane, sessionId) === "waiting";
  }, "cron create did not suspend");
  const sessionId = residentSessionId(plane);
  if (sessionId === undefined) throw new Error("no resident session");
  const kernel = plane.openKernel(sessionId);
  const [firstId, firstChain] = [...foldAlarmChains(kernel, sessionId).entries()][0] ?? ["", undefined];
  if (firstChain === undefined) throw new Error("no armed chain");
  expect(watchStateOf(firstChain, sessionId)).toMatchObject({ kind: "cron", status: "armed", fireAt: FIRST_FIRE });

  // Disable the cron bundle (Owner consent) — the live alarm capability must
  // drop `cron.tick` with the swap, not keep the boot-time registry.
  steps.push(bundleOp("bundle_disable"));
  say("disable cron");
  await consent(sessionId, "bundle_disable");
  const callsAfterDisable = calls;

  // The due tick now fires into an unregistered purpose: one recorded
  // `fired{stale}`, zero handler execution, no alarm prompt, no model wave.
  now = FIRST_FIRE + 1_000;
  await untilCommitted(() => firedOutcomes(plane, sessionId, firstId).length > 0, "disabled cron never fired");
  expect(firedOutcomes(plane, sessionId, firstId)).toEqual(["stale"]);
  expect(alarmPrompts(plane, sessionId)).toHaveLength(0);
  expect(calls).toBe(callsAfterDisable);

  // Re-enable, arm again: the purpose routes once more and the tick delivers.
  steps.push(bundleOp("bundle_enable"));
  say("enable cron");
  await consent(sessionId, "bundle_enable");
  steps.push(cronCreate("cron-create-2"));
  say("arm the grid again");
  await untilCommitted(() => lastTurnTerminal(plane, sessionId) === "waiting", "second cron create did not suspend");
  const secondEntry = [...foldAlarmChains(kernel, sessionId).entries()].find(
    ([id, chain]) => id !== firstId && watchStateOf(chain, sessionId).kind === "cron",
  );
  if (secondEntry === undefined) throw new Error("no second armed chain");
  const [secondId, secondChain] = secondEntry;
  expect(watchStateOf(secondChain, sessionId)).toMatchObject({ kind: "cron", status: "armed", fireAt: SECOND_FIRE });
  const callsBeforeFire = calls;
  now = SECOND_FIRE + 1_000;
  await untilCommitted(() => lastTurnTerminal(plane, sessionId) === "result", "re-enabled cron never prompted");
  expect(firedOutcomes(plane, sessionId, secondId)).toEqual(["delivered"]);
  expect(alarmPrompts(plane, sessionId)).toHaveLength(1);
  expect(calls).toBe(callsBeforeFire + 1);
}, 60_000);
