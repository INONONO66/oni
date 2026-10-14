/**
 * The arm verb against activation passivation and alarm forwarding (audit A4), on the REAL entity:
 * - an arm held across passivation completes before the store closes (finalizer order releaseLive → arm → close),
 *   writes exactly one arm row through the revision retry, and never surfaces as a defect; a later arm through
 *   the stale verb is a typed `stale_activation` refusal;
 * - the store-close wait is bounded: past `armCloseWaitMs` the store closes anyway, and an arm queued behind the
 *   held one still refuses typed;
 * - one forwarder per activation: 1000 arms with a held send start one send, never 1000 concurrent ones;
 * - every sent-then-superseded occurrence (an orphan durable envelope) counts against `maxArmed`, and an
 *   orphan's delivery folds `stale` and frees its slot;
 * - `latestArm` reads one primary-key row, never the arm-row join.
 */
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { Cause, Deferred, Effect, Exit, Queue } from "effect";
import type { LedgerAction } from "@openomni/protocol";
import type { AlarmFired, ArmVerb } from "../../src/core/ports/alarm";
import { openSessionStore } from "../../src/core/store/session-file";
import { createArmedAlarmPorts } from "../../src/core/store/session-file/alarms";
import { liveArmRegistry } from "../helpers/alarm-budget";
import {
  boundedAwait,
  clusterMessages,
  clusterTempDir,
  completionSignal,
  runCluster,
  sendAlarm,
  sendPrompt,
  sessionFileFor,
  type TestClusterOptions,
} from "../helpers/cluster-runtime";

const home = clusterTempDir("a4-arm-passivation-");
const { dir, sessionsDir, catalogFile } = home;
const FAR = 4_102_444_800_000;
const sentQueue = Effect.runSync(Queue.unbounded<string>());
const orphanQueue = Effect.runSync(Queue.unbounded<string>());

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const isArm = (input: { readonly actions: readonly LedgerAction.Append[] }) =>
  input.actions.some((action) => action.kind === "alarm" && JSON.stringify(action.intent ?? "").includes("arm"));

/**
 * Holds the next arm commit at `mode` ("pre": before the write, "post": after it returns) until `release`, and
 * records the finalizer-visible order of releaseLive, the held commit returning, and store.close.
 */
function heldArmHarness(mode: "pre" | "post") {
  const events: string[] = [];
  const entered = completionSignal();
  const released = completionSignal();
  const closed = completionSignal();
  const liveReleased = completionSignal();
  const live = liveArmRegistry();
  let hold = false;
  const wrapStore: NonNullable<TestClusterOptions["wrapStore"]> = (_sessionId, store) => {
    const sessions = store.sessions;
    const commit: typeof sessions.commit = (input) => {
      if (!hold || !isArm(input)) return sessions.commit(input);
      hold = false;
      const wait = Effect.promise(() => released.done);
      const enter = Effect.sync(entered.fire);
      const returned = Effect.sync(() => events.push("arm commit returned"));
      return mode === "pre"
        ? enter.pipe(Effect.andThen(wait), Effect.andThen(sessions.commit(input)), Effect.tap(returned))
        : sessions.commit(input).pipe(Effect.tap(enter), Effect.tap(wait), Effect.tap(returned));
    };
    return new Proxy(store, {
      get(target, key, receiver) {
        if (key === "sessions") return { ...sessions, commit };
        if (key === "close")
          return () => {
            events.push("store.close");
            target.close();
            closed.fire();
          };
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const onLive: NonNullable<TestClusterOptions["onLive"]> = (sessionId, activation) => {
    const release = live.onLive(sessionId, activation);
    return () => {
      events.push("releaseLive");
      release();
      liveReleased.fire();
    };
  };
  return {
    events,
    live,
    wrapStore,
    onLive,
    holdNextArm: () => {
      hold = true;
    },
    entered,
    released,
    closed,
    liveReleased,
  };
}

function armRows(sessionId: string, alarmId: string): { readonly actions: number; readonly armed: number } {
  const db = new Database(sessionFileFor(sessionsDir, sessionId), { readonly: true });
  try {
    const like = `%${alarmId}%`;
    const actions = db.query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM action WHERE kind = 'alarm' AND intent LIKE ?").get(like)?.c ?? 0;
    const armed = db.query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM armed_alarms WHERE alarm_id = ?").get(alarmId)?.c ?? 0;
    return { actions, armed };
  } finally {
    db.close();
  }
}

function armedTotal(sessionId: string): number {
  const db = new Database(sessionFileFor(sessionsDir, sessionId), { readonly: true });
  try {
    return db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM armed_alarms").get()?.c ?? 0;
  } finally {
    db.close();
  }
}

for (const mode of ["pre", "post"] as const) {
  test(`an arm held ${mode}-write across passivation completes before store.close and never dies`, async () => {
    const sessionId = `held-${mode}`;
    const harness = heldArmHarness(mode);
    const result = await runCluster(
      { sessionsDir, catalogFile, idleMs: 400, onLive: harness.onLive, wrapStore: harness.wrapStore, wrapSendAlarm: () => () => Effect.void },
      Effect.gen(function* () {
        yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
        const verb = yield* harness.live.live(sessionId);
        harness.holdNextArm();
        const done = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
        yield* Effect.forkChild(
          verb({ purpose: "test.tick", at: FAR, alarmId: "a-held", sourceKey: "t", payload: {} }).pipe(
            Effect.exit,
            Effect.flatMap((exit) => Deferred.succeed(done, exit)),
          ),
        );
        yield* Effect.promise(() => boundedAwait("arm commit held", harness.entered.done));
        yield* Effect.promise(() => boundedAwait("releaseLive finalizer", harness.liveReleased.done));
        harness.released.fire();
        const exit = yield* Deferred.await(done);
        yield* Effect.promise(() => boundedAwait("store.close finalizer", harness.closed.done));
        const stale = yield* Effect.exit(verb({ purpose: "test.tick", at: FAR, alarmId: "a-late", sourceKey: "t", payload: {} }));
        return { exit, stale };
      }),
    );
    expect(Exit.isFailure(result.exit) && Cause.hasDies(result.exit.cause)).toBe(false);
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(harness.events).toEqual(["releaseLive", "arm commit returned", "store.close"]);
    expect(Exit.isFailure(result.stale) && Cause.hasDies(result.stale.cause)).toBe(false);
    expect(Exit.isFailure(result.stale) ? Cause.squash(result.stale.cause) : undefined).toMatchObject({ code: "stale_activation" });
    expect(armRows(sessionId, "a-held")).toEqual({ actions: 1, armed: 1 });
    expect(armRows(sessionId, "a-late")).toEqual({ actions: 0, armed: 0 });
  }, 60_000);
}

test("the store-close wait is bounded; an arm queued behind the held one refuses stale_activation", async () => {
  const sessionId = "held-timeout";
  const harness = heldArmHarness("pre");
  const result = await runCluster(
    {
      sessionsDir,
      catalogFile,
      idleMs: 400,
      drain: { armCloseWaitMs: 50 },
      onLive: harness.onLive,
      wrapStore: harness.wrapStore,
      wrapSendAlarm: () => () => Effect.void,
    },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      const verb = yield* harness.live.live(sessionId);
      harness.holdNextArm();
      const first = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
      yield* Effect.forkChild(
        verb({ purpose: "test.tick", at: FAR, alarmId: "a-held", sourceKey: "t", payload: {} }).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.succeed(first, exit)),
        ),
      );
      yield* Effect.promise(() => boundedAwait("arm commit held", harness.entered.done));
      yield* Effect.promise(() => boundedAwait("releaseLive finalizer", harness.liveReleased.done));
      const queued = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
      yield* Effect.forkChild(
        verb({ purpose: "test.tick", at: FAR, alarmId: "a-queued", sourceKey: "t", payload: {} }).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.succeed(queued, exit)),
        ),
      );
      // The bound elapses while the first arm still holds the permit: the store closes before its release.
      yield* Effect.promise(() => boundedAwait("store.close after the bounded wait", harness.closed.done));
      const closedWhileHeld = [...harness.events];
      harness.released.fire();
      yield* Deferred.await(first);
      return { closedWhileHeld, queued: yield* Deferred.await(queued) };
    }),
  );
  expect(result.closedWhileHeld).toEqual(["releaseLive", "store.close"]);
  expect(Exit.isFailure(result.queued) && Cause.hasDies(result.queued.cause)).toBe(false);
  expect(Exit.isFailure(result.queued) ? Cause.squash(result.queued.cause) : undefined).toMatchObject({ code: "stale_activation" });
}, 60_000);

/** 64 chains c0..c63, then re-arms of c0. */
const armInput = (i: number) => ({ purpose: "probe", at: FAR + i, alarmId: i < 64 ? `c${i}` : "c0", sourceKey: "probe", payload: { i } });

test("one forwarder per activation: 1000 arms behind a held send start one send, then 65 in order", async () => {
  const sessionId = "fwd-held";
  const live = liveArmRegistry();
  const stats = { started: 0, inFlight: 0, peak: 0 };
  const gate = completionSignal();
  const firstStarted = completionSignal();
  const all = completionSignal();
  const sent: string[] = [];
  const result = await runCluster(
    {
      sessionsDir,
      catalogFile,
      onLive: live.onLive,
      wrapSendAlarm: () => (_sessionId, occurrence) =>
        Effect.suspend(() => {
          stats.started += 1;
          stats.inFlight += 1;
          stats.peak = Math.max(stats.peak, stats.inFlight);
          firstStarted.fire();
          return Effect.promise(() => gate.done).pipe(
            Effect.ensuring(Effect.sync(() => {
              stats.inFlight -= 1;
              sent.push(occurrence.alarmId);
              if (sent.length === 65) all.fire();
            })),
          );
        }),
    },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      const arm = yield* live.live(sessionId);
      let refused = 0;
      for (let i = 0; i < 1000; i++) {
        if (Exit.isFailure(yield* Effect.exit(arm(armInput(i))))) refused += 1;
        if (i === 0) yield* Effect.promise(() => boundedAwait("first forwarded send", firstStarted.done));
      }
      const startedWhileHeld = stats.started;
      gate.fire();
      yield* Effect.promise(() => boundedAwait("65 forwarded sends", all.done));
      return { refused, startedWhileHeld, first: sent[0], last: sent.at(-1) };
    }),
  );
  expect(result).toEqual({ refused: 0, startedWhileHeld: 1, first: "c0", last: "c0" });
  expect(stats.peak).toBe(1);
  expect(sent).toHaveLength(65);
  expect(stats.started).toBe(65);
}, 120_000);

test("re-arms of a sent occurrence count as orphans: 872 of 1000 refused, 128 durable envelopes", async () => {
  const sessionId = "fwd-persisted";
  const live = liveArmRegistry();
  const result = await runCluster(
    {
      sessionsDir,
      catalogFile,
      onLive: live.onLive,
      wrapSendAlarm: (_send, persisted) => (target, occurrence) =>
        persisted(target, occurrence).pipe(Effect.andThen(Queue.offer(sentQueue, occurrence.occurrenceId)), Effect.asVoid),
    },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      const arm = yield* live.live(sessionId);
      let refused = 0;
      for (let i = 0; i < 1000; i++) {
        const exit = yield* Effect.exit(arm(armInput(i)));
        if (Exit.isFailure(exit)) {
          refused += 1;
          expect(Cause.squash(exit.cause)).toMatchObject({ code: "alarm_budget" });
        } else yield* Queue.take(sentQueue);
      }
      const unprocessed = clusterMessages(catalogFile, "Session").filter(
        (row) => row.entity_id === sessionId && row.tag === "Alarm" && row.processed === 0,
      ).length;
      return { refused, unprocessed };
    }),
  );
  expect(result).toEqual({ refused: 872, unprocessed: 128 });
  expect(armedTotal(sessionId)).toBe(64);
}, 120_000);

test("an orphan's delivery folds stale and frees its slot; a retire passes at a full orphan budget", async () => {
  const sessionId = "fwd-orphan";
  const live = liveArmRegistry();
  const sent: AlarmFired[] = [];
  const result = await runCluster(
    {
      sessionsDir,
      catalogFile,
      drain: { maxArmed: 2 },
      onLive: live.onLive,
      wrapSendAlarm: () => (_target, occurrence) =>
        Effect.sync(() => sent.push(occurrence)).pipe(Effect.andThen(Queue.offer(orphanQueue, occurrence.occurrenceId)), Effect.asVoid),
    },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      const arm: ArmVerb = yield* live.live(sessionId);
      const rearm = (i: number) => Effect.exit(arm({ purpose: "probe", at: FAR + i, alarmId: "o", sourceKey: "probe", payload: { i } }));
      const codes: (string | undefined)[] = [];
      for (let i = 0; i < 4; i++) {
        const exit = yield* rearm(i);
        if (Exit.isSuccess(exit)) {
          codes.push(undefined);
          yield* Queue.take(orphanQueue);
        } else codes.push((Cause.squash(exit.cause) as { code?: string }).code);
      }
      const [orphan] = sent;
      if (orphan === undefined) throw new Error("no forwarded occurrence");
      // DeliverAt keys on fireAt; the never-persisted orphan is delivered now instead of at its far-future time.
      const receipt = yield* sendAlarm(sessionId, { ...orphan, fireAt: Date.now() });
      const afterFold = yield* rearm(10);
      yield* Queue.take(orphanQueue);
      const refusedAgain = yield* rearm(11);
      const retire = yield* Effect.exit(arm({ purpose: "probe", at: null, alarmId: "o", sourceKey: "probe", payload: {} }));
      return {
        codes,
        receipt: receipt.outcome,
        afterFold: Exit.isSuccess(afterFold),
        refusedAgain: Exit.isFailure(refusedAgain),
        retire: Exit.isSuccess(retire),
      };
    }),
  );
  // Arm, two orphaning re-arms (budget 2), then refusal; the orphan folds stale and the next re-arm passes.
  expect(result).toEqual({
    codes: [undefined, undefined, undefined, "alarm_budget"],
    receipt: "stale",
    afterFold: true,
    refusedAgain: true,
    retire: true,
  });
  expect(armRows(sessionId, "o").armed).toBe(0);
}, 60_000);

test("latestArm reads one armed_alarms row by primary key: no scan, no temp b-tree", () => {
  const file = sessionFileFor(sessionsDir, "plan-session");
  openSessionStore(file, { now: () => 0 }).close();
  const db = new Database(file);
  try {
    const statements: string[] = [];
    const recording = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "query")
          return (sql: string) => {
            statements.push(sql);
            return target.query(sql);
          };
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(createArmedAlarmPorts(recording).armedAlarm("missing")).toBeUndefined();
    expect(statements).toHaveLength(1);
    const plan = db
      .query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${statements[0] ?? ""}`)
      .all("missing")
      .map((row) => row.detail);
    expect(plan).toEqual([expect.stringMatching(/^SEARCH armed_alarms USING INDEX sqlite_autoindex_armed_alarms_\d \(alarm_id=\?\)$/)]);
  } finally {
    db.close();
  }
});
