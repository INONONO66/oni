/**
 * #1348: the shared fixtures' own contract. Every fixture acquires fresh
 * resources per call, mints fresh collectors, and releases on every exit of
 * the body — including a failing one. These cases pin that, so a suite
 * switched onto a fixture cannot leak state into its neighbor.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { clusterTempDir } from "./cluster-runtime";
import { runAgent } from "./executor";
import {
  fencedSession,
  readArmedAlarms,
  type SessionHandles,
  sessionHandles,
  withSessionHandles,
} from "./seeded-session";
import { liveArmRegistry, liveWatchCapability } from "./alarm-budget";
import { crashingCapability, firedRows, noteArm, resendSignal } from "./alarm-recovery";
import { interestBus, recordingSources } from "./bus-fixture";
import { expectPoisoned, hookRequest, withHookProcess } from "./hook-fixture";

const scopedExit = <A, E>(body: (scope: Scope.Scope) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const exit = yield* body(scope).pipe(Scope.provide(scope), Effect.exit);
    yield* Scope.close(scope, Exit.void);
    return exit;
  });

/**
 * bun:sqlite refuses every read on a closed `Database` with exactly this
 * error; a leaked (still-open) handle answers instead. Asserting it on the
 * captured pair is what lets the teardown pins fail when release leaks.
 */
const closedDatabase = expect.objectContaining({ name: "RangeError", message: "Cannot use a closed database" });
const expectReleased = (handles: Pick<SessionHandles, "catalog" | "store">, sessionId: string) => {
  expect(() => handles.catalog.sessionIndex(sessionId)).toThrow(closedDatabase);
  expect(() => handles.store.armedCount()).toThrow(closedDatabase);
};

describe("seeded-session fixture", () => {
  test("two fencedSession acquisitions of one home seed distinct sessions and close their handles", async () => {
    const home = clusterTempDir("fixtures-seeded-");
    const seen = await runAgent(
      scopedExit((scope) =>
        Effect.gen(function* () {
          const a = yield* fencedSession(home, "s-a");
          const b = yield* fencedSession(home, "s-b");
          expect(a.fence).toBe(1);
          expect(b.fence).toBe(1);
          expect(a.kernel.row("s-a").revision).toBe(b.kernel.row("s-b").revision);
          yield* a.commit([noteArm("s-a", "n", 1, 10).action]);
          return { a: a.kernel.armedCount(), b: b.kernel.armedCount(), scope, pairs: [a, b] as const };
        }),
      ),
    );
    expect(Exit.isSuccess(seen)).toBe(true);
    if (!Exit.isSuccess(seen)) return;
    expect(seen.value).toMatchObject({ a: 1, b: 0 });
    // The scope closed both handle pairs: each acquired pair now refuses reads ...
    const [a, b] = seen.value.pairs;
    expectReleased(a, "s-a");
    expectReleased(b, "s-b");
    // ... and a fresh pair reads the durable rows back.
    expect(readArmedAlarms(home, "s-a")).toHaveLength(1);
    expect(readArmedAlarms(home, "s-b")).toHaveLength(0);
  });

  test("sessionHandles releases on a failing body, so the file reopens cleanly", async () => {
    const home = clusterTempDir("fixtures-release-");
    const acquired: SessionHandles[] = [];
    const exit = await runAgent(
      scopedExit(() =>
        Effect.gen(function* () {
          acquired.push(yield* sessionHandles(home, "s-fail"));
          return yield* Effect.fail(new Error("body failed"));
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // The failing body still released: the captured pair refuses reads ...
    const [released] = acquired;
    expect(released).toBeDefined();
    if (released === undefined) return;
    expectReleased(released, "s-fail");
    // ... and a fresh pair opens the same files cleanly.
    const row = withSessionHandles(home, "s-fail", ({ catalog }) => catalog.sessionIndex("s-fail"));
    expect(row).toBeUndefined();
  });

  test("fencedSession adopts an explicit fence when a pre-crash world is replayed", async () => {
    const home = clusterTempDir("fixtures-fence-");
    const adopted = await runAgent(
      scopedExit(() =>
        Effect.gen(function* () {
          const seeded = yield* fencedSession(home, "s-fence", { fence: 7, owner: "crashed" });
          return { fence: seeded.fence, owner: seeded.owner, live: seeded.kernel.row("s-fence").state };
        }),
      ),
    );
    expect(adopted).toEqual(Exit.succeed({ fence: 7, owner: "crashed", live: "idle" }));
  });
});

describe("alarm-budget fixture", () => {
  test("liveArmRegistry mints a fresh verbs map per call and empties it on release", async () => {
    const first = liveArmRegistry();
    const second = liveArmRegistry();
    expect(first.verbs).not.toBe(second.verbs);
    const release = first.onLive("s", { arm: () => Effect.die("unused") } as never);
    expect(first.verbs.has("s")).toBe(true);
    expect(second.verbs.has("s")).toBe(false);
    release();
    expect(first.verbs.has("s")).toBe(false);
    const dead = await runAgent(first.arm("s")({} as never).pipe(Effect.exit));
    expect(Exit.isFailure(dead)).toBe(true);
  });

  test("liveWatchCapability returns fresh installs/closed collectors per acquisition", async () => {
    const registry = liveArmRegistry();
    const [a, b] = await runAgent(
      Effect.all([liveWatchCapability(registry), liveWatchCapability(registry)]),
    );
    expect(a.installs).not.toBe(b.installs);
    expect(a.closed).not.toBe(b.closed);
    expect(a.definition.purposes).toEqual(b.definition.purposes);
    expect(a.definition.purposes).toContain("monitor.hit");
  });
});

describe("alarm-recovery fixture", () => {
  test("resendSignal settles on the delivered receipt, before or after the waiter attaches", async () => {
    const signal = resendSignal();
    const occurrence = { occurrenceId: "o-1" } as never;
    signal.options.onAlarmResend?.("s", occurrence, { outcome: "delivered" } as never);
    await signal.delivered("o-1");
    const late = signal.delivered("o-2");
    signal.options.onAlarmResend?.("s", { occurrenceId: "o-2" } as never, { outcome: "stale" } as never);
    signal.options.onAlarmResend?.("s", { occurrenceId: "o-2" } as never, { outcome: "delivered" } as never);
    await late;
  });

  test("crashingCapability counts its attempts and never yields a fired row", async () => {
    const capability = crashingCapability();
    const exit = await runAgent(capability.wake({} as never, {} as never).pipe(Effect.exit));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(capability.attempts()).toBe(1);
    const home = clusterTempDir("fixtures-crash-");
    await runAgent(scopedExit(() => fencedSession(home, "s-crash")));
    expect(firedRows(home, "s-crash", "any")).toEqual({ delivered: 0, stale: 0 });
    expect(noteArm("s-crash", "n", 2, 5)).toMatchObject({ action: { id: "n:arm:2", kind: "alarm" } });
  });
});

describe("bus fixture", () => {
  test("interestBus gives each acquisition its own bus and published collector", async () => {
    const [a, b] = await runAgent(Effect.scoped(Effect.all([interestBus(), interestBus()])));
    expect(a.bus).not.toBe(b.bus);
    expect(a.published).not.toBe(b.published);
    const sources = recordingSources(a.published);
    expect(sources.id()).toBe("event-1");
    expect(sources.now()).toBe(2);
    sources.onPublish("x", false);
    expect(a.published).toEqual([{ name: "x", delivered: false }]);
    expect(b.published).toEqual([]);
  });
});

describe("hook fixture", () => {
  test("withHookProcess kills its child on a failing body, and the PID is poisoned after", async () => {
    let pid = -1;
    const exit = await runAgent(
      withHookProcess((hook) =>
        Effect.gen(function* () {
          pid = hook.pid;
          const allowed = yield* hook.call(hookRequest("allow"));
          expect(allowed).toEqual({ kind: "gate", verdict: "allow" });
          return yield* Effect.fail(new Error("body failed"));
        }),
      ).pipe(Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(pid).toBeGreaterThan(0);
    // Release killed the child: the pid is gone (ESRCH), not a zombie we keep signalling.
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  test("a child that dies settles its exit and refuses later calls", async () => {
    const poisoned = await runAgent(
      withHookProcess((hook) =>
        Effect.gen(function* () {
          const died = yield* hook.call(hookRequest("die"));
          expect(died).toMatchObject({ kind: "failure", cause: "exit" });
          return yield* expectPoisoned(hook);
        }),
      ),
    );
    expect(poisoned.later).toMatchObject({ kind: "failure", cause: "exit" });
    expect(poisoned.inFlight).toBe(0);
  });
});
