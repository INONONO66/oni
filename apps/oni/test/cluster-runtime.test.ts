import { composedHolder } from "./helpers/bundle-fixture";
import { APPROVAL_POLICY } from "../src/composition/policy";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";
import { Core } from "@oni/agent";
import { createSessionKernel } from "../../../packages/agent/src/core/store/fence";
const SessionEntity = Core.SessionEntity;
type SessionEntityPorts = Core.SessionEntityPorts;
type SessionEntityTurnInput = Core.SessionEntityTurnInput;
type ObservationPublishFailure = Core.ObservationPublishFailure;
import type { Delivery, ObservationSink } from "@oni/protocol";
import { Effect, Fiber } from "effect";
import { gatewayRuntime, runAppEffect } from "../src/gateway";
import { createSessionEntityPortsSlot, interruptFailureCause } from "../src/composition/cluster-runtime";
import { AdmissionFailure, DeliverRefused } from "../../../packages/agent/src/core/journal/messages";
import { createAppLedger } from "./helpers/ledger";
import { runEffect } from "./helpers/effect";
import { requestFixture } from "../../../packages/agent/test/store/helpers/request";
import { materializeSession } from "../../../packages/agent/test/store/helpers/session";
import { testClock } from "./helpers/test-entropy";
import { Bus } from "./helpers/bus";

/** A sink that refuses every post-commit publish. */
const REFUSING_SINK: ObservationSink = {
  publish() {
    throw new Error("sink failed");
  },
};

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "oni-cluster-"));
  directories.push(directory);
  return directory;
}

/** Entity activations refuse unknown sessions: materialize + index first. */
async function provisionSession(
  catalogPath: string,
  sessionsDir: string,
  sessionId: string,
): Promise<void> {
  const now = testClock();
  const plane = createAppLedger({ now, catalogPath, sessionsDir });
  try {
    const kernel = plane.openKernel(sessionId);
    await runEffect(
      kernel.materialize({
        actionId: `${sessionId}:materialize`,
        at: now(),
        id: sessionId,
        parentId: null,
        policyGeneration: 1,
        role: "resident",
        system: { preset: "", blocks: [] },
        tools: [],
      }),
    );
    plane.catalog.indexSession({
      id: sessionId,
      parentId: null,
      role: "resident",
      createdAt: now(),
    });
  } finally {
    plane.close();
  }
}

function origin(sessionId: string, messageId: string): string {
  const value: Delivery.MessageOrigin = {
    kind: "message",
    messageId,
    senderSessionId: sessionId,
    sourceActionId: messageId,
  };
  return JSON.stringify(value);
}

function readFence(catalogPath: string, sessionId: string): number | undefined {
  const db = new Database(catalogPath, { readonly: true });
  try {
    return db
      .query<{ fence: number }, [string]>("SELECT fence FROM session_index WHERE id = ?")
      .get(sessionId)?.fence;
  } finally {
    db.close();
  }
}

test("AppLive hosts the session entity: prompts append through the fenced kernel and dedupe on redelivery", async () => {
  const directory = tempDir();
  const catalogPath = join(directory, "catalog.sqlite");
  const sessionsDir = join(directory, "sessions");
  const sessionId = "cluster-app-session";
  const decisions: SessionEntityTurnInput["decision"]["kind"][] = [];
  const ports: SessionEntityPorts = {
    approvalPolicy: APPROVAL_POLICY,
    // Admission refuses a snapshot with no declared capability kinds and
    // deliver refuses an unbound inputRegistrations port (#1313); this
    // fixture states the composed tables like the booted app's port binding.
    capabilityKinds: ["tool", "compaction"],
    inputRegistrations: ["prompt", "signal"],
    runTurn: (input) =>
      Effect.suspend(() => {
        decisions.push(input.decision.kind);
        // Detach a never-sealing body (W5.2 S4): the delivering RPC acks at
        // the durable boundary and later drains defer to the live turn.
        return input.detach(Effect.never);
      }),
  };
  const runtime = gatewayRuntime({ composed: composedHolder(),
    observations: Bus,
    catalogPath,
    sessionsDir,
    entityIdleMs: 60_000,
    entity: { owner: "app-test-runner", ports },
  });
  try {
    await provisionSession(catalogPath, sessionsDir, sessionId);
    const message = {
      kind: "prompt",
      body: JSON.stringify({ content: "hello" }),
      source: origin(sessionId, "m-1"),
      idempotencyKey: "m-1",
    };
    const fireAt = testClock();
    const { first, replay, retry, deadline, fired, timeout } = await runAppEffect(
      runtime,
      Effect.scoped(
        Effect.gen(function* () {
          const makeClient = yield* SessionEntity.client;
          const entity = makeClient(sessionId);
          const first = yield* entity.Deliver(message);
          // Same idempotency key: the persisted envelope replays the recorded
          // receipt byte-identically; nothing runs twice.
          const replay = yield* entity.Deliver(message);
          // Chain-guarded alarm folds (F2/#1253): unknown alarm/request keys
          // and capability purposes with no bound alarm capability (#1254 S4)
          // fold to recorded stale facts — fail-closed.
          const retry = yield* entity.Alarm({
            occurrenceId: "missing-alarm:retry:1",
            purpose: "retry",
            alarmId: "missing-alarm:retry:1",
            armSeq: 1,
            sourceKey: "retry",
            payload: JSON.stringify({ attempt: 1 }),
            fireAt: fireAt(),
          });
          const deadline = yield* entity.Alarm({
            occurrenceId: "missing-request:deadline",
            purpose: "deadline",
            alarmId: "missing-request:deadline",
            armSeq: 1,
            sourceKey: "deadline",
            payload: JSON.stringify({ requestId: "missing-request" }),
            fireAt: fireAt(),
          });
          const fired = yield* entity.Alarm({
            occurrenceId: "missing-watch:1:missing-source",
            purpose: "watch.fired",
            alarmId: "missing-watch",
            armSeq: 1,
            sourceKey: "missing-watch:1:missing-source",
            payload: JSON.stringify({
              watchId: "missing-watch",
              epoch: 1,
              sourceKey: "missing-watch:1:missing-source",
              batch: "[]",
            }),
            fireAt: fireAt(),
          });
          const timeout = yield* entity.Alarm({
            occurrenceId: "missing-watch:timeout:1",
            purpose: "watch.timeout",
            alarmId: "missing-watch",
            armSeq: 1,
            sourceKey: "watch.timeout",
            payload: JSON.stringify({ watchId: "missing-watch" }),
            fireAt: fireAt(),
          });
          return { first, replay, retry, deadline, fired, timeout };
        }),
      ),
    );
    expect(first).toEqual({ seq: 2, existed: false });
    expect(replay).toEqual(first);
    expect(retry).toEqual({ outcome: "stale" });
    expect(deadline).toEqual({ outcome: "stale" });
    expect(fired).toEqual({ outcome: "stale" });
    expect(timeout).toEqual({ outcome: "stale" });
    // The one admitted prompt started one (detached, never-sealing) turn;
    // the replay and the stale alarms never reach the turn port.
    expect(decisions).toEqual(["start"]);
    // One activation rotated the catalog fence exactly once (F5).
    expect(readFence(catalogPath, sessionId)).toBe(1);
  } finally {
    await runtime.dispose();
  }
}, 20_000);

test("a post-commit publish failure reaches the injected port and leaves the write result intact", () => {
  const failures: ObservationPublishFailure[] = [];
  const plane = createAppLedger({
    now: testClock(),
    observationSink: REFUSING_SINK,
    onObservationFailure: (failure) => failures.push(failure),
  });
  try {
    const kernel = plane.openKernel("request-session");
    const fixture = requestFixture(kernel);
    fixture.commit([fixture.original]);
    expect(kernel.actionById("original")?.id).toBe("original");
    expect(failures.map((failure) => [failure.actionId, failure.cause.message])).toEqual([
      ["request-session:configure", "sink failed"],
      ["original", "sink failed"],
    ]);
  } finally {
    plane.close();
  }
});

test("without an injected port a publish failure on a file-mode handle is an incident log line", () => {
  const incident = spyOn(console, "error").mockImplementation((): void => undefined);
  const plane = createAppLedger({
    now: testClock(),
    sessionsDir: join(tempDir(), "sessions"),
    observationSink: REFUSING_SINK,
  });
  const store = plane.handles.openSession("ported-session");
  try {
    materializeSession(
      createSessionKernel(store, plane.catalog),
      "ported-session",
    );
    expect(store.sessions.get("ported-session")?.id).toBe("ported-session");
    expect(incident.mock.calls).toEqual([
      ["ledger observation publish failed: ported-session:configure", new Error("sink failed")],
    ]);
  } finally {
    incident.mockRestore();
    store.close();
    plane.close();
  }
});

test("late-bound entity ports refuse early use and forward after one binding", async () => {
  const plane = createAppLedger({ now: testClock() });
  const slot = createSessionEntityPortsSlot();
  const { sendAlarm, alarmCapability, onKeepAlive, requestDomainRevisions, ready, onRequestReady } =
    slot.ports;
  if (
    sendAlarm === undefined ||
    alarmCapability === undefined ||
    onKeepAlive === undefined ||
    requestDomainRevisions === undefined ||
    ready === undefined ||
    onRequestReady === undefined
  )
    throw new Error("the slot must delegate every optional entity port");
  const occurrence = {
    occurrenceId: "late:fire:1",
    purpose: "cron.tick",
    alarmId: "late",
    armSeq: 1,
    sourceKey: "cron",
    payload: "{}",
    fireAt: 100,
  };
  const context: Core.AlarmWakeContext = {
    sessionId: "late-session",
    reads: { latestArm: () => undefined, settled: () => false },
    arm: () => Effect.die(new Error("unused arm")),
    now: 100,
    prompt: () => Effect.succeed({ seq: 1 }),
  };
  try {
    // Before boot binds the real ports, every delegating port is a typed
    // refusal and the capability reports no purposes — no wake can dispatch.
    await expect(runEffect(sendAlarm("late-session", occurrence))).rejects.toThrow(
      "session entity ports are not bound yet",
    );
    await expect(runEffect(alarmCapability.wake(occurrence, context))).rejects.toThrow(
      "session entity ports are not bound yet",
    );
    expect(alarmCapability.purposes).toEqual([]);
    expect(() => onKeepAlive(true)).not.toThrow();
    // The doorbell before binding has nobody to ring and must not throw: a
    // redelivered Resolve can only reach an activation that passed `ready`.
    expect(() => onRequestReady("late-session")).not.toThrow();
    // An activation parks on `ready` instead of dying: the gate is still
    // open-ended here and settles exactly when boot binds the ports.
    const readyProbe: string[] = [];
    const parked = await runEffect(
      Effect.forkDetach(ready.pipe(Effect.tap(() => Effect.sync(() => readyProbe.push("ready"))))),
    );
    expect(readyProbe).toEqual([]);
    const forwarded: string[] = [];
    const keepAlive: boolean[] = [];
    const rung: string[] = [];
    const ports: SessionEntityPorts = {
      approvalPolicy: APPROVAL_POLICY,
      runTurn: () => Effect.void,
      onRequestReady: (sessionId) => rung.push(sessionId),
      sendAlarm: (sessionId, fired) =>
        Effect.sync(() => {
          forwarded.push(`${sessionId}:${fired.occurrenceId}`);
        }),
      alarmCapability: {
        purposes: ["cron.tick"],
        wake: (fired) =>
          Effect.sync(() => {
            forwarded.push(`wake:${fired.purpose}`);
            return "delivered" as const;
          }),
      },
      onKeepAlive: (enabled) => keepAlive.push(enabled),
      requestDomainRevisions: () => ({ person: 3 }),
    };
    slot.bind(ports);
    await runEffect(Fiber.join(parked));
    expect(readyProbe).toEqual(["ready"]);
    onRequestReady("late-session");
    expect(rung).toEqual(["late-session"]);
    await runEffect(sendAlarm("late-session", occurrence));
    expect(await runEffect(alarmCapability.wake(occurrence, context))).toBe("delivered");
    expect(alarmCapability.purposes).toEqual(["cron.tick"]);
    onKeepAlive(true);
    onKeepAlive(false);
    expect(forwarded).toEqual(["late-session:late:fire:1", "wake:cron.tick"]);
    expect(keepAlive).toEqual([true, false]);
    const fixture = requestFixture(plane.openKernel("late-session"));
    expect(requestDomainRevisions(fixture.request)).toEqual({ person: 3 });
    expect(() => slot.bind(ports)).toThrow("session entity ports are already bound");
  } finally {
    plane.close();
  }
});

test("the facade interrupt names a typed door refusal by its code and stringifies anything else", () => {
  expect(interruptFailureCause(new DeliverRefused({ code: "missing_key" }))).toBe("DeliverRefused:missing_key");
  expect(interruptFailureCause(new AdmissionFailure({ code: "revision" }))).toBe("AdmissionFailure:revision");
  const boundary = new Core.AgentFailure({ operation: "session.prompt", cause: "denied" });
  expect(interruptFailureCause(boundary)).toBe(String(boundary));
  expect(interruptFailureCause(boundary)).not.toContain(":denied");
});
