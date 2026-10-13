import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Bundle, Core } from "@openomni/agent";
type ExecutionApprovalRequest = Core.ExecutionApprovalRequest;
import { Bus, newTraceId } from "./helpers/bus";
import { Effect } from "effect";
import { type Alarm, canonicalDigest, L0Observation, Operational, type PlainObject } from "@openomni/protocol";
import type { AppSessionHandle } from "../src";
import {
  assistantMessage,
  requestToolStep,
} from "./helpers/assistant-message";
import { adoptTestFence, planeOf } from "./helpers/ledger";
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { foldAlarmChains, watchStateOf } from "../src/composition/alarm-plane";
import { testMachinesPlane } from "./helpers/self-machine";
import { bounded } from "./helpers/protected-dispatch";
import { runEffect } from "./helpers/effect";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";
import { waveTool } from "./helpers/session-wave";
import { testToolsBundle } from "./helpers/app-fixture";
import { testIds } from "./helpers/test-entropy";
import { nextFrame } from "./helpers/ws";
import { approvalPolicy } from "./helpers/approval-policy";
import { materializeResident } from "./helpers/resident-materialize";

const suite = residentSuite();

function fifoWakeWriter(fifo: string) {
  const writer = Bun.spawn(["/bin/sh", "-c", `printf 'WAKE\\n' > '${fifo}'`]);
  suite.defer(async () => {
    if (writer.exitCode === null) writer.kill();
    await writer.exited;
  });
}

function expectTimeoutCompanion(plane: Awaited<ReturnType<typeof planeOf>>, sessionId: string, occurrenceId: string) {
  const chain = foldAlarmChains(plane.openKernel(sessionId), sessionId).get(`${sessionId}-watch:timeout`);
  if (chain === undefined) throw new Error("timeout chain lost");
  expect(chain.latest.occurrenceId).toBe(occurrenceId);
  expect(chain.latest.at).toBe(4_102_444_800_000);
}

async function restartApp(config: ReturnType<typeof suite.config>) {
  const app = await suite.boot({ config: { ...config, machines: testMachinesPlane() }, llm: stopLlm });
  return planeOf(app.runtime);
}

/** A held fake model: the test owns when the turn's one model call returns. */
async function heldTurnApp(prefix: string, entropy?: () => string) {
  const entered = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const app = await suite.boot({
    config: suite.config(prefix, { wsToken: "interrupt-token" }),
    ...(entropy === undefined ? {} : { sessionRuntime: { entropy } }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input) => Effect.gen(function* () {
        entered.resolve(input.trace.sessionId);
        yield* Effect.promise(() => release.promise);
        return { type: "stop" as const };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "interrupt-token"]);
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "interrupt this turn" }));
  const sessionId = await bounded(entered.promise);
  const handle = app.sessions.get(sessionId);
  if (handle === undefined) throw new Error("live turn missing");
  return { app, plane, sessionId, handle, release };
}

function signalRows(plane: Awaited<ReturnType<typeof planeOf>>, sessionId: string) {
  return sessionTree(sessionId, plane.sessionStore(sessionId).actions).filter((action) => action.kind === "signal");
}

test("facade interrupt rides the entity Deliver signal: the activation's writer commits the row under its own fence", async () => {
  const { plane, sessionId, handle, release } = await heldTurnApp("index-interrupt-");
  const kernel = plane.openKernel(sessionId);
  // #1346: the live activation holds the fence under the runner's writer
  // identity; the interrupt row must land under THAT owner and fence (the
  // single writer's CAS), never under a fence another writer adopted.
  const live = kernel.row(sessionId);
  expect(live).toMatchObject({ state: "running", fenceOwner: `openomni:${process.pid}` });
  const committed: { readonly id: string; readonly revision: number }[] = [];
  suite.defer(
    Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
      if (event.sessionId === sessionId && event.kind === "signal") committed.push({ id: event.id, revision: event.revision });
    }),
  );
  try {
    const interrupted = runEffect(handle.interrupt());
    release.resolve();
    await bounded(interrupted);
    const signals = signalRows(plane, sessionId);
    // One received interrupt row from the session itself, consumed by the
    // turn's own `before_llm` boundary drain.
    expect(signals.map((action) => action.effect.value)).toEqual([
      { deliveryKind: "interrupt", content: "" },
      expect.objectContaining({ phase: "delivery", kind: "interrupt", boundary: "before_llm", deliveryId: signals[0]?.id }),
    ]);
    expect(signals[0]?.intent.value).toEqual({ kind: "session", id: sessionId });
    // Writer identity: the row committed on the live chain (after the turn
    // rows the activation wrote) and the fence owner/fence never changed
    // hands around it — the activation's own CAS, no other writer.
    expect(committed.find((event) => event.id === signals[0]?.id)?.revision).toBeGreaterThan(live.revision);
    const after = kernel.row(sessionId);
    expect([after.fenceOwner, after.fence]).toEqual([live.fenceOwner, live.fence]);
    expect(after.state).toBe("interrupted");
  } finally {
    release.resolve();
  }
});

test("two concurrent facade interrupts serialize at the entity door: both land, both drain, no stray signal", async () => {
  // Re-homed stale-revision case: the deleted app retry duplicated a row on a
  // revision race; the entity's single writer serializes the two interrupts
  // at its own CAS — each lands exactly once and each is drained by the live
  // turn's boundary (the second as a no-op on the already-interrupted turn),
  // so nothing stays pending for the NEXT turn to abort.
  const { plane, sessionId, handle, release } = await heldTurnApp("index-interrupt-twice-");
  const kernel = plane.openKernel(sessionId);
  try {
    const first = runEffect(handle.interrupt());
    const second = runEffect(handle.interrupt());
    release.resolve();
    await bounded(Promise.all([first, second]));
    const signals = signalRows(plane, sessionId).map((action) => ({ id: action.id, value: action.effect.value }));
    const interrupts = signals.filter((signal) => (signal.value as { deliveryKind?: string }).deliveryKind === "interrupt");
    expect(interrupts).toHaveLength(2);
    for (const interrupt of interrupts) {
      expect(signals.filter((signal) => (signal.value as { deliveryId?: string }).deliveryId === interrupt.id)).toHaveLength(1);
    }
    expect(kernel.pendingMessages(sessionId)).toEqual([]);
    expect(kernel.row(sessionId).state).toBe("interrupted");
  } finally {
    release.resolve();
  }
});

test("facade interrupt surfaces the entity door's typed refusal as its code", async () => {
  // The interrupt's idempotency key is minted from the app's entropy; an
  // empty key is the door's `missing_key` refusal, which the facade reports
  // as `tag:code` with no row committed and the held turn left intact.
  const ids = testIds("index-interrupt-refused");
  let blank = false;
  const { plane, sessionId, handle, release } = await heldTurnApp(
    "index-interrupt-refused-",
    () => (blank ? "" : ids()),
  );
  const kernel = plane.openKernel(sessionId);
  try {
    const before = kernel.row(sessionId);
    blank = true;
    const failure = await bounded(runEffect(Effect.flip(handle.interrupt())));
    blank = false;
    expect(failure).toMatchObject({
      _tag: "AgentFailure",
      operation: "session.interrupt",
      cause: "DeliverRefused:missing_key",
    });
    expect(signalRows(plane, sessionId)).toEqual([]);
    expect(kernel.row(sessionId)).toMatchObject({ state: "running", revision: before.revision });
  } finally {
    release.resolve();
  }
});

test("live approval readiness notifies the facade and arms its deadline", async () => {
  const modelEntered = Promise.withResolvers<string>();
  const releaseModel = Promise.withResolvers<void>();
  let calls = 0;
  const running = await suite.boot({
    config: suite.config("index-live-approval-", { wsToken: "index-token" }),
    bundles: [testToolsBundle([waveTool("B", async () => "approved")])],
    sessionRuntime: { approvalTimeoutMs: 60_000 },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) =>
        Effect.gen(function* () {
          calls += 1;
          if (calls === 1) {
            yield* Effect.promise(() => {
              modelEntered.resolve(input.trace.sessionId);
              return releaseModel.promise;
            });
            requestToolStep(input, sink, {
              id: "approval-call",
              tool: "B",
              input: { slot: "B" },
            });
          } else {
            sink.onMessage(assistantMessage(input, { text: "approved" }));
          }
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(running.runtime);
  expect(
    plane.catalog.policies.append(approvalPolicy("index-approval")),
  ).toBe(true);
  const waiting = Promise.withResolvers<{
    readonly handle: AppSessionHandle;
    readonly request: ExecutionApprovalRequest;
  }>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    const handle = running.sessions.get(event.sessionId);
    const request = handle?.approvals.pending()[0];
    if (handle !== undefined && request !== undefined) waiting.resolve({ handle, request });
  });
  suite.defer(unsubscribe);
  const socket = await suite.openSocket(`ws://127.0.0.1:${running.port}/ws`, [
    "auth",
    "index-token",
  ]);
  const response = nextResidentTurn(plane, 5000);

  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "request approval" }));

  const sessionId = await bounded(modelEntered.promise);
  expect(running.sessions.get(sessionId)).toBeDefined();
  const kernel = plane.openKernel(sessionId);
  releaseModel.resolve();
  const { handle, request } = await bounded(waiting.promise);
  expect(request.expiresAt).toBeGreaterThan(0);
  const latestGenerationFor = kernel.latestGenerationFor;
  Object.defineProperty(kernel, "latestGenerationFor", {
    configurable: true,
    value: () => {
      throw new Error("corrupt generation fixture");
    },
  });
  const answerReceipt = nextFrame(socket, (frame) => frame.type === "receipt");
  socket.send(
    JSON.stringify({
      type: "request_answer",
      inputId: "index-wired-approval-answer",
      request: request.durable,
      decision: "approve",
      credential: "index-token",
    }),
  );
  try {
    expect(await answerReceipt).toMatchObject({
      inputId: "index-wired-approval-answer",
      result: { status: "executed" },
    });
    expect(kernel.requestById(request.durable.requestId)?.state).toBe("resolved");
  } finally {
    Object.defineProperty(kernel, "latestGenerationFor", {
      configurable: true,
      value: latestGenerationFor,
    });
  }
  expect(await response).toMatchObject({ text: "approved" });
  await running.stop();
  expect(
    await runEffect(
      Effect.flip(handle.requests.timeout("stale-request", Date.now())).pipe(Effect.orDie),
    ),
  ).toMatchObject({ code: "approval_authority_unavailable" });
});

test("a stale owner answer with no live turn rides the entity Resolve and is rejected", async () => {
  // #1253: a session that is neither live in this process nor a process
  // runner answers out-of-turn through the entity's Resolve RPC; a typed
  // ResolveRefused (unknown request here) surfaces as the `rejected`
  // resolution and the receipt frame, never a dead socket.
  const app = await suite.boot({
    config: suite.config("index-stale-resolve-", { wsToken: "stale-token" }),
    llm: {
      resolveModel: fakeProviderModel,
      run: () => Effect.sync(() => ({ type: "stop" as const })),
    },
  });
  const plane = await planeOf(app.runtime);
  const sessionId = "stale-resolve-target";
  await materializeResident(plane, sessionId, 1);
  const parsedInput = { slot: "ghost" };
  const request = {
    requestId: "ghost-request",
    sessionId,
    turnId: null,
    callId: "ghost-call",
    mode: "approval",
    parsedInput,
    inputHash: canonicalDigest(parsedInput),
    effectHash: "ghost-effect",
    generation: 1,
    toolsGeneration: 1,
    toolsHash: "ghost-tools",
    systemHash: "ghost-system",
    domainRevisions: {},
    deadline: Date.now() + 60_000,
    expectedResponders: ["owner"],
    correlation: {},
    allowedActions: ["report_result"],
    bindingDigest: "ghost-binding",
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "open",
    outcome: null,
    createdAt: 1,
  };
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "stale-token"]);
  const receipt = nextFrame(
    socket,
    (frame) => frame.type === "receipt" && frame.inputId === "stale-entity-answer",
  );
  socket.send(
    JSON.stringify({
      type: "request_answer",
      inputId: "stale-entity-answer",
      request,
      decision: "approve",
      credential: "stale-token",
    }),
  );
  expect(await bounded(receipt)).toMatchObject({
    inputId: "stale-entity-answer",
    result: { status: "blocked_pre", reasonCode: "request_answer.rejected" },
  });
});

test("a path watch timeout reaches the session entity", async () => {
  const directory = suite.tempDir("index-watch-timeout-");
  const watched = join(directory, "watched");
  writeFileSync(watched, "stable");
  let calls = 0;
  const app = await suite.boot({
    config: suite.config("index-watch-timeout-db-", { wsToken: "index-watch-token" }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) =>
        Effect.sync(() => {
          calls += 1;
          if (calls === 1)
            requestToolStep(input, sink, {
              id: "watch-timeout-call",
              tool: "monitor",
              input: {
                operation: {
                  op: "create",
                  description: "timeout coverage",
                  source: { kind: "path", path: watched, event: "modify", timeout_ms: 20 },
                },
              },
            });
          else sink.onMessage(assistantMessage(input, { text: "timed out" }));
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const fired = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind === "alarm") fired.resolve();
  });
  suite.defer(unsubscribe);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, [
    "auth",
    "index-watch-token",
  ]);

  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "create timeout watch" }));

  await bounded(fired.promise);
  expect(calls).toBeGreaterThanOrEqual(1);
  expect(plane.listSessions().some((row) => row.id !== "gateway-ingress")).toBe(true);
});

test("a deadline-bearing external send opens and arms its live request", async () => {
  let sent = false;
  const modelWaiting = Promise.withResolvers<void>();
  const releaseModel = Promise.withResolvers<void>();
  const sendEntered = Promise.withResolvers<void>();
  const releaseSend = Promise.withResolvers<void>();
  const config = suite.config("index-deadline-send-", {
    wsToken: "index-send-token",
    actors: [
      {
        actorId: "owner",
        externalId: "owner",
        kind: "human",
        trustTier: "owner",
      },
      {
        actorId: "peer",
        externalId: "peer",
        kind: "ai_agent",
        trustTier: "assigned_worker",
      },
    ],
    socialBudgets: [
      {
        id: "peer-budget",
        targetActorId: "peer",
        maxPerWindow: 5,
        windowMs: 1000,
        cooldownMs: 0,
      },
    ],
  });
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) =>
        Effect.gen(function* () {
          if (!sent) {
            yield* Effect.promise(() => {
              sendEntered.resolve();
              return releaseSend.promise;
            });
            const result = requestToolStep(input, sink, {
              id: "deadline-send",
              tool: "send_message",
              input: {
                to: { kind: "contact", id: "peer" },
                message: "DEADLINE_QUESTION",
                deadline_ms: 60_000,
              },
            });
            if (result === undefined) return { type: "stop" as const };
            sent = true;
          }
          yield* Effect.promise(() => {
            modelWaiting.resolve();
            return releaseModel.promise;
          });
          sink.onMessage(assistantMessage(input, { text: "DEADLINE_WAITING" }));
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const owner = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, [
    "auth",
    "index-send-token",
  ]);
  const peer = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=peer`, [
    "auth",
    "index-send-token",
  ]);
  const question = nextFrame(peer, (frame) => frame.type === "message");
  const terminal = nextResidentTurn(plane, 5000);
  const deadlineFailure = Promise.withResolvers<void>();
  suite.defer(Bus.subscribe(Operational.Events.Error, () => deadlineFailure.resolve()));

  owner.send(JSON.stringify({ eventId: newTraceId(), text: "send with deadline" }));

  await bounded(sendEntered.promise);
  if (config.catalogPath === undefined) throw new Error("missing test catalog");
  const catalog = new Database(config.catalogPath);
  catalog.exec(
    "CREATE TRIGGER refuse_deadline_message BEFORE INSERT ON cluster_messages BEGIN SELECT RAISE(ABORT, 'forced deadline refusal'); END",
  );
  catalog.close();
  releaseSend.resolve();
  const delivery = await question;
  expect(delivery).toMatchObject({ text: "DEADLINE_QUESTION" });
  if (delivery.type !== "message") throw new Error("missing deadline question");
  await bounded(modelWaiting.promise);
  const liveSource = plane.listSessions().find((row) => row.id !== "gateway-ingress");
  if (liveSource === undefined) throw new Error("missing live source session");
  expect(app.sessions.get(liveSource.id)).toBeDefined();
  const receipt = nextFrame(peer, (frame) => frame.type === "receipt");
  peer.send(
    JSON.stringify({
      text: "DEADLINE_ANSWER",
      replyToId: delivery.messageId,
      eventId: "index-deadline-answer",
    }),
  );
  expect(await receipt).toMatchObject({ status: "accepted" });
  releaseModel.resolve();
  await terminal;
  await bounded(deadlineFailure.promise);
  const source = plane.listSessions().find((row) => row.id !== "gateway-ingress");
  if (source === undefined) throw new Error("missing source session");
  expect(
    plane
      .openKernel(source.id)
      .requestRows(source.id)
      .some((request) => request.deadline !== null),
  ).toBe(true);
});

test("a terminal watch to an unknown machine is refused at create and its chains are retired", async () => {
  let calls = 0;
  const config = suite.config("index-watch-refused-db-", { wsToken: "index-refused-token" });
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) =>
        Effect.sync(() => {
          calls += 1;
          if (calls === 1)
            requestToolStep(input, sink, {
              id: "terminal-watch-refused",
              tool: "monitor",
              input: {
                operation: {
                  op: "create",
                  description: "ghost terminal",
                  source: { kind: "terminal", machine: "m-ghost", session: "qa", timeout_ms: 60_000 },
                },
              },
            });
          else sink.onMessage(assistantMessage(input, { text: "refused" }));
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const sealed = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "turn") return;
    const snapshot = plane.openKernel(event.sessionId).getSnapshot(event.sessionId);
    if (snapshot.turns.at(-1)?.terminal?.kind === "result") sealed.resolve();
  });
  suite.defer(unsubscribe);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "index-refused-token"]);

  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "watch the ghost terminal" }));

  await bounded(sealed.promise);
  expect(calls).toBe(2);
  const session = plane.listSessions().find((row) => row.id !== "gateway-ingress");
  if (session === undefined) throw new Error("no resident session");
  // Both chains (main + timeout) were armed, failed to subscribe, and retired:
  // every latest arm is `at: null` with the install-refusal reason.
  const chains = [...foldAlarmChains(plane.openKernel(session.id), session.id).values()];
  expect(chains).toHaveLength(2);
  for (const chain of chains) {
    expect(chain.latest.at).toBeNull();
    expect(chain.armCount).toBe(2);
  }
  const main = chains.find((chain) => !chain.alarmId.endsWith(":timeout"));
  if (main === undefined) throw new Error("no main watch chain");
  expect(watchStateOf(main, session.id)).toMatchObject({ kind: "watch", status: "cancelled", fireAt: null });
  const before = sessionTree(session.id, plane.sessionStore(session.id).actions)
    .filter((action) => action.kind === "alarm" && action.id.endsWith(":delivered")).length;
  await app.stop();
  const restarted = await restartApp(config);
  const recovered = restarted.openKernel(session.id);
  const retired = foldAlarmChains(recovered, session.id).get(main.alarmId);
  if (retired === undefined) throw new Error("retired watch lost on restart");
  expect(watchStateOf(retired, session.id)).toMatchObject({ status: "cancelled", fireAt: null });
  expect(recovered.armedCount()).toBe(0);
  expect(sessionTree(session.id, restarted.sessionStore(session.id).actions)
    .filter((action) => action.kind === "alarm" && action.id.endsWith(":delivered"))).toHaveLength(before);
});

test("boot rescan wakes armed idle sessions and skips ghost catalog rows and native chains", async () => {
  const config = suite.config("index-rescan-db-", { wsToken: "index-rescan-token" });
  const app1 = await suite.boot({
    config,
    llm: { resolveModel: fakeProviderModel, run: () => Effect.succeed({ type: "stop" as const }) },
  });
  const plane1 = await planeOf(app1.runtime);
  const sessionId = "rescan-seed";
  const kernel = plane1.openKernel(sessionId);
  await materializeResident(plane1, sessionId, kernel.currentPolicyGeneration());
  const fence = await runEffect(adoptTestFence(kernel, sessionId, "rescan-seeder"));
  // One scheduled chain with an unregistered purpose (folds to fired{stale})
  // and one native monitor.hit chain (never resent by the boot rescan).
  const due = Core.armAction({
    parentId: `${sessionId}:materialize`,
    sessionId,
    purpose: "note.due",
    at: 1_000,
    supersedes: null,
    alarmId: "due-1",
    sourceKey: "note",
    payload: {},
    armSeq: 1,
    ts: 2,
  });
  const native = Core.armAction({
    parentId: due.action.id,
    sessionId,
    purpose: Bundle.MONITOR_HIT,
    at: 2_000,
    supersedes: null,
    alarmId: "native-1",
    sourceKey: Bundle.MONITOR_SOURCE,
    payload: { spec: { watch: { command: "true", description: "native", persistent: true }, policyGeneration: 1, notificationLimit: 8 }, notifications: 0 },
    armSeq: 2,
    ts: 3,
  });
  await runEffect(
    kernel.commit({
      sessionId,
      owner: "rescan-seeder",
      fence,
      now: 3,
      expectedRevision: kernel.row(sessionId).revision,
      actions: [due.action, native.action],
      state: "idle",
    }),
  );
  // A catalog row without a session file: the boot mtime probe must fall back.
  plane1.catalog.indexSession({ id: "rescan-ghost", parentId: null, role: "resident", createdAt: 1 });
  await app1.stop();

  const staleFolded = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId === sessionId && event.kind === "alarm") staleFolded.resolve();
  });
  suite.defer(unsubscribe);
  // Same catalog and sessions dir, fresh machine socket: a real reboot.
  const app2 = await suite.boot({
    config: { ...config, machines: testMachinesPlane() },
    llm: { resolveModel: fakeProviderModel, run: () => Effect.succeed({ type: "stop" as const }) },
  });
  const plane2 = await planeOf(app2.runtime);
  await bounded(staleFolded.promise);
  const kernel2 = plane2.openKernel(sessionId);
  // The resent occurrence folded to a recorded stale fact (purpose unregistered).
  expect(kernel2.actionById(`${due.occurrenceId}:stale`)?.kind).toBe("alarm");
  expect(kernel2.actionById(`${due.occurrenceId}:delivered`)).toBeUndefined();
  // The native chain was never resent: no fired fact exists for its occurrence.
  expect(kernel2.actionById(`${native.occurrenceId}:stale`)).toBeUndefined();
  expect(kernel2.actionById(`${native.occurrenceId}:delivered`)).toBeUndefined();
});

/** An idle-armed seed session: one scheduled `note.due` chain, fence rotated once. */
async function seedArmedSession(plane: Awaited<ReturnType<typeof planeOf>>, sessionId: string) {
  const kernel = plane.openKernel(sessionId);
  await materializeResident(plane, sessionId, kernel.currentPolicyGeneration());
  const fence = await runEffect(adoptTestFence(kernel, sessionId, "fault-seeder"));
  const due = Core.armAction({
    parentId: `${sessionId}:materialize`,
    sessionId,
    purpose: "note.due",
    at: 1_000,
    supersedes: null,
    alarmId: `${sessionId}-due`,
    sourceKey: "note",
    payload: {},
    armSeq: 1,
    ts: 2,
  });
  await runEffect(
    kernel.commit({
      sessionId,
      owner: "fault-seeder",
      fence,
      now: 3,
      expectedRevision: kernel.row(sessionId).revision,
      actions: [due.action],
      state: "idle",
    }),
  );
  return due;
}

const stopLlm = {
  resolveModel: fakeProviderModel,
  run: () => Effect.succeed({ type: "stop" as const }),
};

/** The committed MONITOR_HIT arm payload for one watch spec. */
const watchHit = (watch: Alarm.WatchSpec["watch"]): PlainObject => ({
  spec: { watch, policyGeneration: 1, notificationLimit: 8 },
  notifications: 0,
});

/** Seeds one armed MONITOR_HIT chain (given payload) plus its scheduled timeout companion. */
async function seedNativeSession(
  plane: Awaited<ReturnType<typeof planeOf>>,
  sessionId: string,
  payload: PlainObject,
) {
  const kernel = plane.openKernel(sessionId);
  await materializeResident(plane, sessionId, kernel.currentPolicyGeneration());
  const fence = await runEffect(adoptTestFence(kernel, sessionId, "native-seeder"));
  const hit = Core.armAction({
    parentId: `${sessionId}:materialize`,
    sessionId,
    purpose: Bundle.MONITOR_HIT,
    at: 2_000,
    supersedes: null,
    alarmId: `${sessionId}-watch`,
    sourceKey: Bundle.MONITOR_SOURCE,
    payload,
    armSeq: 1,
    ts: 2,
  });
  const timeout = Core.armAction({
    parentId: hit.action.id,
    sessionId,
    purpose: Bundle.MONITOR_TIMEOUT,
    at: 4_102_444_800_000,
    supersedes: null,
    alarmId: `${sessionId}-watch:timeout`,
    sourceKey: Bundle.MONITOR_SOURCE,
    payload: { watchId: `${sessionId}-watch` },
    armSeq: 2,
    ts: 3,
  });
  await runEffect(
    kernel.commit({
      sessionId,
      owner: "native-seeder",
      fence,
      now: 3,
      expectedRevision: kernel.row(sessionId).revision,
      actions: [hit.action, timeout.action],
      state: "idle",
    }),
  );
  return { hit, timeout };
}

test("an activation's armed monitor.hit resend reinstalls the native source across a reboot (#1254 H2)", async () => {
  const fifo = join(suite.tempDir("index-native-resend-"), "source");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const config = suite.config("index-native-resend-db-", { wsToken: "index-native-token" });
  const app1 = await suite.boot({ config, llm: stopLlm });
  const plane1 = await planeOf(app1.runtime);
  const sessionId = "native-resend";
  const { hit, timeout } = await seedNativeSession(plane1, sessionId, watchHit({
    command: `cat '${fifo}'; read value`,
    filter: "^WAKE$",
    description: "native resend",
    persistent: true,
  }));
  await app1.stop();

  // #1254 r2 M3: the barrier is the LAST fact of the wake path — the
  // fired{delivered} commit for the seeded occurrence (production order:
  // prompt commit -> re-arm -> handler returns -> fired append). Resolving on
  // the prompt commit raced the producer: the delivered/chain assertions ran
  // against state the wake fiber had not committed yet. Subscribed before boot.
  const woke = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId === sessionId && event.id === `${hit.occurrenceId}:delivered`) {
      woke.resolve();
    }
  });
  suite.defer(unsubscribe);
  const plane2 = await restartApp(config);
  // The writer's open blocks until the reinstalled source's `cat` attaches to
  // the fifo — the rendezvous IS the install proof, no readiness polling.
  fifoWakeWriter(fifo);
  await bounded(woke.promise);
  const kernel2 = plane2.openKernel(sessionId);
  // The hit delivered under the seeded occurrence and prompted its content.
  expect(kernel2.actionById(`${hit.occurrenceId}:delivered`)?.kind).toBe("alarm");
  const prompt = kernel2.actionById(`${hit.occurrenceId}:prompt`);
  if (prompt?.kind !== "prompt") throw new Error("missing wake prompt");
  // The companion timeout chain was scheduled, not retired: still armed on
  // the original occurrence, untouched by the hit path.
  expectTimeoutCompanion(plane2, sessionId, timeout.occurrenceId);
});

test.each<[string, PlainObject]>([
  // A terminal watch whose machine does not exist: install can never succeed.
  [
    "ghost machine",
    watchHit({ machine: "m-ghost", session: "qa", description: "ghost terminal", persistent: true }),
  ],
  // A payload that carries no watch spec at all: nothing to install.
  ["no watch spec", { notifications: 0 }],
])("an uninstallable armed monitor.hit (%s) retires its chain with send_refused at reboot (#1254 H2)", async (label, payload) => {
  const slug = label.replace(/\s+/g, "-");
  const config = suite.config(`index-native-refused-${slug}-db-`, { wsToken: "index-refusal-token" });
  const app1 = await suite.boot({ config, llm: stopLlm });
  const plane1 = await planeOf(app1.runtime);
  const sessionId = `native-refused-${slug}`;
  const { hit, timeout } = await seedNativeSession(plane1, sessionId, payload);
  await app1.stop();

  // The ONLY alarm commit this reboot can produce for the session is the
  // entity's retire of the refused chain — subscribe before boot.
  const retired = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId === sessionId && event.kind === "alarm") retired.resolve();
  });
  suite.defer(unsubscribe);
  const plane2 = await restartApp(config);
  await bounded(retired.promise);
  const kernel2 = plane2.openKernel(sessionId);
  const chains = foldAlarmChains(kernel2, sessionId);
  const watchChain = chains.get(`${sessionId}-watch`);
  if (watchChain === undefined) throw new Error("watch chain lost");
  // Retired: a fresh arm superseding the refused occurrence, at: null, typed reason.
  expect(watchChain.latest.at).toBeNull();
  expect(watchChain.armCount).toBe(2);
  expect(watchChain.latest.supersedes).toBe(hit.occurrenceId);
  expect(watchChain.latest.payload).toMatchObject({ reason: "send_refused" });
  // No fired fact was invented for the refused occurrence.
  expect(kernel2.actionById(`${hit.occurrenceId}:delivered`)).toBeUndefined();
  expect(kernel2.actionById(`${hit.occurrenceId}:stale`)).toBeUndefined();
  // The scheduled timeout companion is untouched and still armed.
  expectTimeoutCompanion(plane2, sessionId, timeout.occurrenceId);
});

test("refused alarm sends (sqlite trigger fault) fail one session's rescan and another's activation resend without touching their armed rows", async () => {
  const config = suite.config("index-resend-fault-db-", { wsToken: "index-fault-token" });
  if (config.catalogPath === undefined) throw new Error("missing test catalog");
  const app1 = await suite.boot({ config, llm: stopLlm });
  const plane1 = await planeOf(app1.runtime);
  const ok = await seedArmedSession(plane1, "fault-ok");
  const rescanDue = await seedArmedSession(plane1, "fault-rescan");
  const resendDue = await seedArmedSession(plane1, "fault-resend");
  await app1.stop();

  // Fault injection at the cluster mailbox: the boot `rescan` envelope for one
  // session and the activation's armed `note.due` resend for another are
  // refused at the insert, so each awaited send fails with a real error.
  const catalog = new Database(config.catalogPath);
  catalog.exec(
    "CREATE TRIGGER refuse_rescan_send BEFORE INSERT ON cluster_messages WHEN NEW.tag = 'Alarm' AND NEW.entity_id = 'fault-rescan' BEGIN SELECT RAISE(ABORT, 'injected rescan send refusal'); END",
  );
  catalog.exec(
    "CREATE TRIGGER refuse_resend BEFORE INSERT ON cluster_messages WHEN NEW.tag = 'Alarm' AND NEW.entity_id = 'fault-resend' AND NEW.payload LIKE '%\"purpose\":\"note.due\"%' BEGIN SELECT RAISE(ABORT, 'injected resend refusal'); END",
  );
  catalog.close();

  const okStale = Promise.withResolvers<void>();
  const rescanLogged = Promise.withResolvers<void>();
  const resendLogged = Promise.withResolvers<void>();
  const rescanFailures: string[] = [];
  suite.defer(Bus.subscribe(Operational.Events.Error, (event) => {
    if (event.msg.includes("fault-rescan")) { rescanFailures.push(event.msg); rescanLogged.resolve(); }
  }));
  // #1254 H2 / r2 M4: a transient resend failure is a defect the ENTITY logs
  // (the armed row stands); Effect's default logger writes through
  // console.log. The log is identified by the injected error's own sentinel
  // (the trigger's RAISE message riding the rendered cause), never by the
  // production log sentence — rewording the log must not break this test.
  const INJECTED_RESEND = "injected resend refusal";
  const original = console.log.bind(console);
  const logs = spyOn(console, "log").mockImplementation((...args: string[]) => {
    const line = args.map(String).join(" ");
    if (line.includes(INJECTED_RESEND)) resendLogged.resolve();
    else original(...args);
  });
  suite.defer(() => logs.mockRestore());
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId === "fault-ok" && event.kind === "alarm") okStale.resolve();
  });
  suite.defer(unsubscribe);
  const plane2 = await restartApp(config);
  await bounded(Promise.all([okStale.promise, rescanLogged.promise, resendLogged.promise]));

  // The healthy session folded its due chain stale as usual.
  expect(plane2.openKernel("fault-ok").actionById(`${ok.occurrenceId}:stale`)?.kind).toBe("alarm");
  // Refused rescan send: boot completed, the session was never activated and
  // its armed row stands with no fired fact.
  const rescanKernel = plane2.openKernel("fault-rescan");
  expect(rescanKernel.actionById(rescanDue.action.id)).toBeDefined();
  expect(rescanKernel.actionById(`${rescanDue.occurrenceId}:stale`)).toBeUndefined();
  expect(rescanKernel.actionById(`${rescanDue.occurrenceId}:delivered`)).toBeUndefined();
  // Refused activation resend: the entity came up, the resend failed, nothing
  // was retired and no fired fact was recorded — the chain stays armed.
  const resendKernel = plane2.openKernel("fault-resend");
  expect(resendKernel.actionById(resendDue.action.id)).toBeDefined();
  expect(resendKernel.actionById(`${resendDue.occurrenceId}:stale`)).toBeUndefined();
  expect(resendKernel.actionById(`${resendDue.occurrenceId}:delivered`)).toBeUndefined();
  // Secondary: each injected fault surfaced exactly one failure report.
  expect(rescanFailures).toHaveLength(1);
  const logLines = logs.mock.calls.map((call: string[]) => call.join(" "));
  expect(logLines.filter((line) => line.includes(INJECTED_RESEND))).toHaveLength(1);
});

test("activation resend persists every armed envelope at the insert, never awaiting a future occurrence's reply (M3)", async () => {
  const config = suite.config("index-resend-future-db-", { wsToken: "index-future-token" });
  if (config.catalogPath === undefined) throw new Error("missing test catalog");
  const app1 = await suite.boot({ config, llm: stopLlm });
  const plane1 = await planeOf(app1.runtime);
  const sessionId = "future-resend";
  const kernel = plane1.openKernel(sessionId);
  await materializeResident(plane1, sessionId, kernel.currentPolicyGeneration());
  const fence = await runEffect(adoptTestFence(kernel, sessionId, "future-seeder"));
  // Two far-future chains that no reply will settle today, followed in fire
  // order by an uninstallable monitor.hit chain whose refused send is the
  // walk's OWN last fact: the sequential resend reaches it only after both
  // future inserts, so its retire commit is the causal barrier.
  const arm = (alarmId: string, at: number, armSeq: number) =>
    Core.armAction({
      parentId: `${sessionId}:materialize`,
      sessionId,
      purpose: "note.due",
      at,
      supersedes: null,
      alarmId,
      sourceKey: "note",
      payload: {},
      armSeq,
      ts: 2,
    });
  const FAR_FUTURE = 4_102_444_800_000; // 2100-01-01Z: undeliverable today, replies only then
  const futureA = arm("due-future-a", FAR_FUTURE, 1);
  const futureB = arm("due-future-b", FAR_FUTURE + 3_600_000, 2);
  const refused = Core.armAction({
    parentId: `${sessionId}:materialize`,
    sessionId,
    purpose: Bundle.MONITOR_HIT,
    at: FAR_FUTURE + 7_200_000,
    supersedes: null,
    alarmId: "barrier-watch",
    sourceKey: Bundle.MONITOR_SOURCE,
    payload: {
      spec: {
        watch: { machine: "m-ghost", session: "qa", description: "barrier", persistent: true },
        policyGeneration: 1,
        notificationLimit: 8,
      },
      notifications: 0,
    },
    armSeq: 3,
    ts: 2,
  });
  await runEffect(
    kernel.commit({
      sessionId,
      owner: "future-seeder",
      fence,
      now: 3,
      expectedRevision: kernel.row(sessionId).revision,
      actions: [futureA.action, futureB.action, refused.action],
      state: "idle",
    }),
  );
  await app1.stop();

  const walked = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId === sessionId && event.kind === "alarm") walked.resolve();
  });
  suite.defer(unsubscribe);
  const plane2 = await restartApp(config);
  // The refused watch sorts LAST in the armed index: the only alarm commit a
  // reboot can produce here is its send_refused retire (#1254 H2), appended
  // by the walk itself strictly after both future inserts were issued.
  await bounded(walked.promise);
  const barrier = foldAlarmChains(plane2.openKernel(sessionId), sessionId).get("barrier-watch");
  if (barrier === undefined) throw new Error("barrier chain lost");
  expect(barrier.latest.at).toBeNull();
  expect(barrier.latest.payload).toMatchObject({ reason: "send_refused" });

  // Persist-and-return: both future envelopes are durable in the catalog
  // mailbox now; a reply-awaiting send would still be parked on due-future-a.
  const catalog = new Database(config.catalogPath, { readonly: true });
  const rows = catalog
    .query<{ payload: string }, [string]>(
      "SELECT payload FROM cluster_messages WHERE tag = 'Alarm' AND entity_id = ?",
    )
    .all(sessionId);
  catalog.close();
  expect(rows.some((row) => row.payload.includes(futureA.occurrenceId))).toBe(true);
  expect(rows.some((row) => row.payload.includes(futureB.occurrenceId))).toBe(true);
});
