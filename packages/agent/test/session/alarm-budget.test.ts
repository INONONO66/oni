/**
 * The per-session armed-alarm budget against the REAL entity: `ctx.arm` succeeds until the durable armed index
 * holds `maxArmed` rows, then receives `ArmRefused{code: alarm_budget}`; reserved purposes get `reserved_purpose`
 * regardless of headroom. At a full budget a re-arm (upsert) and a retire (`at: null`) still commit — only an arm
 * that adds a chain consults the budget — and the retire frees one slot. The same wake commits one alarm-originated prompt.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect, Result } from "effect";
import type { Alarm } from "@oni/protocol";
import { armAction, firedAction, type AlarmCapability, type ArmRefused } from "../../src/core/ports/alarm";
import { alarmCapability, WatchRefused } from "../../src/plugins/alarm";
import { liveArmRegistry, liveWatchCapability } from "../helpers/alarm-budget";
import { clusterTempDir, runCluster, sendAlarm, sendKick, sendPrompt } from "../helpers/cluster-runtime";
import { runAgent } from "../helpers/executor";
import {
  fencedSession,
  materializeSession,
  readArmedAlarms,
  sessionHandles,
  withSessionHandles,
} from "../helpers/seeded-session";

const home = clusterTempDir("w52-alarm-budget-");
const { dir, sessionsDir, catalogFile } = home;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sessionId = "budget-session";
const MAX_ARMED = 64;
const FAR_FUTURE = 4_102_444_800_000;

// Non-empty on purpose: the resent occurrence must carry the arm's payload as
// JSON bytes a capability can parse (`{}` would pass under any serializer).
const BOOT_PAYLOAD = { reason: "boot", attempt: 1, tags: ["a", "b"] };

test("ctx.arm fills the budget to maxArmed, then ArmRefused{alarm_budget}; re-arm/retire pass at full budget; reserved purposes always refuse", async () => {
  // Seed: one committed boot arm (purpose test.tick) whose resent occurrence
  // triggers the capability wake on activation.
  const boot = await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        const seeded = yield* fencedSession(home, sessionId);
        const armed = armAction({
          parentId: `${sessionId}:materialize`,
          sessionId,
          purpose: "test.tick",
          at: 100,
          supersedes: null,
          alarmId: "boot",
          sourceKey: "boot",
          payload: BOOT_PAYLOAD,
          armSeq: seeded.kernel.row(sessionId).revision + 1,
          ts: 100,
        });
        yield* seeded.commit([armed.action], 100);
        return armed;
      }),
    ),
  );

  // The wake arms until refused; results surface through this settled promise.
  interface WakeReport {
    readonly armed: number;
    readonly refusal: ArmRefused | undefined;
    readonly reserved: ArmRefused | undefined;
    /** At the full budget: re-arm of tick-0, retire of tick-1, then one new chain. */
    readonly atFull: {
      readonly rearm: ArmRefused | { readonly alarmId: string; readonly armSeq: number };
      readonly retire: ArmRefused | { readonly alarmId: string };
      readonly freed: ArmRefused | { readonly alarmId: string };
    };
    readonly prompt: { readonly seq: number };
    readonly fired: {
      readonly occurrenceId: string;
      readonly alarmId: string;
      readonly payload: string;
    };
  }
  let resolveReport: (report: WakeReport) => void = () => undefined;
  const report = new Promise<WakeReport>((resolve) => {
    resolveReport = resolve;
  });
  const capability: AlarmCapability = {
    purposes: ["test.tick"],
    wake: (fired, ctx) =>
      Effect.gen(function* () {
        const prompt = yield* ctx.prompt({ content: "WAKE tick", payload: { detail: "line:1" } });
        const reserved = yield* Effect.result(
          ctx.arm({ purpose: "retry", at: FAR_FUTURE, payload: {}, sourceKey: "t" }),
        );
        let armed = 0;
        let refusal: ArmRefused | undefined;
        // The boot row occupies one slot until its fired fact retires it, so
        // headroom is maxArmed - 1; the next attempt crosses the budget.
        for (let index = 0; index < MAX_ARMED; index += 1) {
          const outcome = yield* Effect.result(
            ctx.arm({
              purpose: "test.tick",
              at: FAR_FUTURE + index,
              payload: { index },
              alarmId: `tick-${index}`,
              sourceKey: "t",
            }),
          );
          if (Result.isFailure(outcome)) {
            refusal = outcome.failure;
            break;
          }
          armed += 1;
        }
        const settle = <A>(outcome: Result.Result<A, ArmRefused>) =>
          Result.isFailure(outcome) ? outcome.failure : outcome.success;
        const rearm = settle(
          yield* Effect.result(
            ctx.arm({ purpose: "test.tick", at: FAR_FUTURE + 1_000, payload: {}, alarmId: "tick-0", sourceKey: "t" }),
          ),
        );
        const retire = settle(
          yield* Effect.result(
            ctx.arm({ purpose: "test.tick", at: null, payload: {}, alarmId: "tick-1", sourceKey: "t" }),
          ),
        );
        const freed = settle(
          yield* Effect.result(
            ctx.arm({ purpose: "test.tick", at: FAR_FUTURE, payload: {}, alarmId: "tick-freed", sourceKey: "t" }),
          ),
        );
        resolveReport({
          armed,
          refusal,
          reserved: Result.isFailure(reserved) ? reserved.failure : undefined,
          atFull: { rearm, retire, freed },
          prompt,
          fired: {
            occurrenceId: fired.occurrenceId,
            alarmId: fired.alarmId,
            payload: fired.payload,
          },
        });
        return "delivered" as const;
      }),
  };

  const outcome = await runCluster(
    { sessionsDir, catalogFile, alarmCapability: capability },
    Effect.gen(function* () {
      // Any occurrence activates the entity; activation resends the boot arm,
      // whose delivery runs the wake above.
      yield* sendKick(sessionId);
      return yield* Effect.promise(() => report);
    }),
  );

  expect(outcome.reserved?.code).toBe("reserved_purpose");
  expect(outcome.armed).toBe(MAX_ARMED - 1);
  expect(outcome.refusal?.code).toBe("alarm_budget");
  // Full budget: the upsert and the delete commit (neither adds a row); the
  // retire frees exactly one slot for a new chain.
  expect(outcome.atFull.rearm).toMatchObject({ alarmId: "tick-0" });
  expect(outcome.atFull.retire).toMatchObject({ alarmId: "tick-1" });
  expect(outcome.atFull.freed).toMatchObject({ alarmId: "tick-freed" });

  // Durable index after the wake: the boot row retired on `fired{delivered}`,
  // the 63 accepted arms remain; the wake's prompt is one `prompt` row keyed
  // by the fired occurrence with the core-fixed alarm origin.
  const after = withSessionHandles(home, sessionId, ({ kernel }) => ({
    armed: kernel.armedAlarms(),
    prompt: kernel.actionById(`${outcome.fired.occurrenceId}:prompt`),
  }));
  expect(after.armed.find((row) => row.occurrenceId === boot.occurrenceId)).toBeUndefined();
  // 63 accepted arms − retired tick-1 + tick-freed; tick-0 moved to its re-arm.
  expect(after.armed).toHaveLength(MAX_ARMED - 1);
  expect(after.armed.find((row) => row.alarmId === "tick-1")).toBeUndefined();
  expect(after.armed.find((row) => row.alarmId === "tick-freed")).toBeDefined();
  expect(after.armed.find((row) => row.alarmId === "tick-0")?.fireAt).toBe(FAR_FUTURE + 1_000);
  expect(outcome.fired.alarmId).toBe("boot");
  expect(JSON.parse(outcome.fired.payload)).toEqual(BOOT_PAYLOAD);
  expect(after.prompt?.kind).toBe("prompt");
  expect(after.prompt?.ordinal).toBe(outcome.prompt.seq);
  expect(after.prompt?.effect.value).toMatchObject({ content: [{ kind: "text", text: "WAKE tick" }] });
  expect(after.prompt?.intent.value).toMatchObject({
    kind: "alarm",
    alarmId: "boot",
    occurrenceId: outcome.fired.occurrenceId,
    purpose: "test.tick",
    sourceKey: "boot",
    payload: { detail: "line:1" },
  });
});

test("the app capability path arms through the live activation's budgeted entity verb — one committing door (H3)", async () => {
  const sessionId = "live-budget-session";
  // Seed: the session exists (materialized + indexed) but holds no armed rows.
  await runAgent(
    Effect.scoped(sessionHandles(home, sessionId).pipe(Effect.flatMap((handles) => materializeSession(handles, sessionId)))),
  );

  // The app-side registry shape (H3): activations hand their budgeted arm
  // verb to the composition root; the capability delegates — no app commit.
  const live = liveArmRegistry();
  const outcome = await runCluster(
    { sessionsDir, catalogFile, onLive: live.onLive },
    Effect.gen(function* () {
      // Activation: the Deliver turn resolves and the entity stays live (idle 60s).
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      const capability = yield* alarmCapability({
        bundles: [
          {
            bundle: "t",
            purposes: [{ name: "test.tick", handler: () => Effect.succeed("delivered" as const) }],
          },
        ],
        arm: live.arm,
        watch: { install: () => Effect.void },
      });
      let armed = 0;
      let refusal: ArmRefused | undefined;
      for (let index = 0; index <= MAX_ARMED; index += 1) {
        const attempt = yield* Effect.result(
          capability.verbs.arm(sessionId, "turn-1")({
            purpose: "test.tick",
            at: FAR_FUTURE + index,
            alarmId: `app-${index}`,
            sourceKey: "t",
            payload: { index },
          }),
        );
        if (Result.isFailure(attempt)) {
          refusal = attempt.failure;
          break;
        }
        armed += 1;
      }
      return { armed, refusal };
    }),
  );
  // 64 chains through the app path commit against the entity's budget; the
  // 65th is the typed refusal, not an app-side commit.
  expect(outcome.armed).toBe(MAX_ARMED);
  expect(outcome.refusal?.code).toBe("alarm_budget");

  // Durable index: exactly the budget — no second committing path added rows.
  expect(readArmedAlarms(home, sessionId)).toHaveLength(MAX_ARMED);
});

test("r2 H2: a refusal after the first committed arm retires exactly the committed chains through the real entity verb", async () => {
  const sessionId = "h2-compensation-session";
  const live = liveArmRegistry();
  const timedSpec: Alarm.WatchSpec = {
    watch: { command: "true", description: "timed", timeout_ms: 60_000 },
    policyGeneration: 1,
    notificationLimit: 2,
  };
  const outcome = await runCluster(
    { sessionsDir, catalogFile, onLive: live.onLive },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      // Install refused under a committed timeout chain: BOTH chains retire.
      const { definition: refusing } = yield* liveWatchCapability(live, {
        install: () => Effect.fail(new WatchRefused({ reason: "no machines plane" })),
      });
      const installRefused = yield* Effect.flip(
        refusing.verbs.watch({
          sessionId,
          turnId: "turn-1",
          watchId: "h2-install",
          spec: timedSpec,
          now: FAR_FUTURE,
        }),
      );
      // Fill the budget to maxArmed - 1 so the timed watch's main arm takes
      // the LAST slot and its timeout arm is the typed boundary refusal.
      const { definition: working, installs } = yield* liveWatchCapability(live);
      const armDirect = working.verbs.arm(sessionId, "turn-1");
      for (let index = 0; index < MAX_ARMED - 1; index += 1)
        yield* armDirect({
          purpose: "monitor.hit",
          at: FAR_FUTURE + index,
          alarmId: `h2-fill-${index}`,
          sourceKey: "monitor",
          payload: {},
        });
      const budgetRefused = yield* Effect.flip(
        working.verbs.watch({
          sessionId,
          turnId: "turn-1",
          watchId: "h2-watch",
          spec: timedSpec,
          now: FAR_FUTURE,
        }),
      );
      return { installRefused, budgetRefused, installs };
    }),
  );
  // The caller receives the ORIGINAL typed refusals, not a compensation error.
  expect(outcome.installRefused).toBeInstanceOf(WatchRefused);
  expect((outcome.installRefused as WatchRefused).reason).toBe("no machines plane");
  expect(outcome.budgetRefused).toMatchObject({ _tag: "ArmRefused", code: "alarm_budget" });
  // The refused watch's native source was never installed.
  expect(outcome.installs).toEqual([]);
  // Durable index: exactly the fillers — no partially created watch survives
  // (main retired after the timeout refusal; install-refused chains retired).
  const armed = readArmedAlarms(home, sessionId);
  expect(armed).toHaveLength(MAX_ARMED - 1);
  expect(
    armed.filter((row) => row.alarmId.startsWith("h2-watch") || row.alarmId.startsWith("h2-install")),
  ).toEqual([]);
});

test("r2 H3: a fence-stale commit from a zombie activation is the typed ArmRefused stale_activation", async () => {
  const sessionId = "h3-stale-activation-session";
  const live = liveArmRegistry();
  const refused = await runCluster(
    { sessionsDir, catalogFile, onLive: live.onLive },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      const verb = yield* live.live(sessionId);
      // Sanity: the live activation commits under its pinned fence.
      yield* verb({ purpose: "h3.tick", at: FAR_FUTURE, alarmId: "h3-live", sourceKey: "t", payload: {} });
      // A successor elsewhere takes the session over: rotate + adopt the fence.
      yield* Effect.promise(() =>
        runAgent(
          Effect.scoped(
            sessionHandles(home, sessionId, Date.now).pipe(
              Effect.flatMap(({ catalog, kernel }) =>
                kernel.adoptFence({ sessionId, owner: "usurper", fence: catalog.rotateFence(sessionId) }),
              ),
            ),
          ),
        ),
      );
      // The zombie's next commit is a typed refusal, not a defect.
      return yield* Effect.flip(
        verb({ purpose: "h3.tick", at: FAR_FUTURE, alarmId: "h3-zombie", sourceKey: "t", payload: {} }),
      );
    }),
  );
  expect(refused).toMatchObject({ _tag: "ArmRefused", code: "stale_activation" });
  // The zombie appended nothing: only the sane pre-usurp arm is indexed.
  expect(readArmedAlarms(home, sessionId).map((row) => row.alarmId)).toEqual(["h3-live"]);
});

test("r2 H3: three exhausted CAS attempts on the arm commit surface the typed ArmRefused revision", async () => {
  const sessionId = "h3-revision-session";
  const live = liveArmRegistry();
  const contend = { active: false, bumps: 0 };
  // One REAL competing row lands through a second kernel right before each of
  // the entity's commit attempts, so every bounded attempt sees a moved
  // revision — deterministic contention, no sleeps.
  const competingBump = Effect.scoped(
    sessionHandles(home, sessionId, Date.now).pipe(
      Effect.flatMap(({ kernel }) => {
        const row = kernel.row(sessionId);
        contend.bumps += 1;
        return kernel.commit({
          sessionId,
          owner: row.fenceOwner ?? "competitor",
          fence: row.fence,
          now: Date.now(),
          expectedRevision: row.revision,
          actions: [
            firedAction({
              parentId: null,
              sessionId,
              purpose: "h3.tick",
              alarmId: "h3-competitor",
              occurrenceId: `h3-competitor-${contend.bumps}`,
              outcome: "stale",
              ts: Date.now(),
            }),
          ],
          state: row.state,
        });
      }),
    ),
  );
  const refused = await runCluster(
    {
      sessionsDir,
      catalogFile,
      onLive: live.onLive,
      wrapStore: (id, store) => {
        if (id !== sessionId) return store;
        const sessions = store.sessions;
        const wrapped: typeof sessions = {
          ...sessions,
          commit: (input) =>
            contend.active && input.actions.some((action) => action.id.startsWith("h3-cas:arm:"))
              ? competingBump.pipe(
                  Effect.orDie,
                  Effect.flatMap(() => sessions.commit(input)),
                )
              : sessions.commit(input),
        };
        Object.defineProperty(store, "sessions", { value: wrapped });
        return store;
      },
    },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      const verb = yield* live.live(sessionId);
      contend.active = true;
      const refusal = yield* Effect.flip(
        verb({ purpose: "h3.tick", at: FAR_FUTURE, alarmId: "h3-cas", sourceKey: "t", payload: {} }),
      );
      contend.active = false;
      return refusal;
    }),
  );
  expect(refused).toMatchObject({ _tag: "ArmRefused", code: "revision" });
  // Exactly the bounded three attempts hit the contended commit.
  expect(contend.bumps).toBe(3);
});

test("r2 M2 (H5): a settled watch wakes exactly once — the exhausted hit retires both chains and the later timeout delivery lapses stale", async () => {
  const sessionId = "h5-sequence-session";
  const live = liveArmRegistry();
  // A far-future timeout: the DeliverAt door alone would release it in an
  // hour, so the TEST — not the wall clock — decides when it arrives (r3 M2).
  const TIMEOUT_MS = 3_600_000;
  const spec: Alarm.WatchSpec = {
    watch: { command: "true", description: "timed", timeout_ms: TIMEOUT_MS },
    policyGeneration: 1,
    notificationLimit: 1,
  };
  const { definition: capability, installs, closed } = await runAgent(liveWatchCapability(live));
  const readArmed = Effect.sync(() => readArmedAlarms(home, sessionId));
  // r3 M2: HOLD the entity's forked DeliverAt forwards instead of racing them.
  // The explicit `sendAlarm` sends below are then the ONLY envelopes under
  // those occurrence ids, and each RPC ack — sent only after the corresponding
  // fired-fact commit (messages.ts F4) — is the exact, bounded completion
  // barrier. No polling, no wall-clock ordering.
  const heldForwards: string[] = [];
  const outcome = await runCluster(
    {
      sessionsDir,
      catalogFile,
      alarmCapability: capability,
      wrapSendAlarm: () => (_, occurrence) =>
        Effect.sync(() => {
          heldForwards.push(occurrence.alarmId);
        }),
      onLive: live.onLive,
    },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      // The REAL watch verb arms the main chain and its timeout companion;
      // both DeliverAt forwards are held by the wrapper above.
      const armNow = Date.now();
      const main = yield* capability.verbs.watch({
        sessionId,
        turnId: "turn-1",
        watchId: "h5",
        spec,
        now: armNow,
      });
      const timeoutRow = (yield* readArmed).find((row) => row.alarmId === "h5:timeout");
      if (timeoutRow === undefined) return yield* Effect.die(new Error("missing timeout row"));
      // The exhausting native hit (budget 1) retires the main chain AND the
      // companion; the `delivered` ack arrives only after the fired fact and
      // the retiring arms committed — the committed-retirement barrier.
      const hit = yield* sendAlarm(sessionId, {
        occurrenceId: main.occurrenceId,
        purpose: "monitor.hit",
        alarmId: "h5",
        armSeq: main.armSeq,
        sourceKey: "monitor",
        payload: JSON.stringify({
          spec,
          notifications: 0,
          hit: { content: "DONE", terminal: false, detail: "line:1" },
        }),
        fireAt: armNow,
      }).pipe(Effect.timeout("15 seconds"), Effect.orDie);
      // Only AFTER that committed retirement: release the held timeout
      // occurrence through the entity\u2019s alarm RPC. `fireAt: armNow` makes the
      // envelope due NOW — the chain guard folds on occurrenceId/alarmId/
      // armSeq, not the instant — and the `stale` ack follows the committed
      // `<occurrenceId>:stale` fact.
      const late = yield* sendAlarm(sessionId, {
        occurrenceId: timeoutRow.occurrenceId,
        purpose: timeoutRow.purpose,
        alarmId: timeoutRow.alarmId,
        armSeq: timeoutRow.armSeq,
        sourceKey: timeoutRow.sourceKey,
        payload: timeoutRow.payload,
        fireAt: armNow,
      }).pipe(Effect.timeout("15 seconds"), Effect.orDie);
      return { main, timeoutRow, hit, late, armNow };
    }),
  );
  expect(outcome.hit).toMatchObject({ outcome: "delivered" });
  // The retired companion\u2019s late delivery folded to the recorded stale fact.
  expect(outcome.late).toMatchObject({ outcome: "stale" });
  // The timeout was armed at exactly `now + timeout_ms` (injected instants,
  // no elapsed-wall-clock assertion — r3 M2).
  expect(outcome.timeoutRow.fireAt).toBe(outcome.armNow + TIMEOUT_MS);
  // The entity forwarded both committed chains to the (held) DeliverAt door.
  expect([...heldForwards].sort()).toEqual(["h5", "h5:timeout"]);
  expect(installs).toEqual(["h5"]);
  // The exhausted hit\u2019s handler closed the native source exactly once; the
  // stale timeout fold ran zero handler effects.
  expect(closed).toEqual(["h5"]);
  // Durable facts: zero watch-plane rows survive; exactly ONE prompt
  // committed; the late timeout delivery folded to fired{stale}.
  const after = withSessionHandles(home, sessionId, ({ kernel }) => ({
    armed: kernel.armedAlarms(),
    hitPrompt: kernel.actionById(`${outcome.main.occurrenceId}:prompt`),
    timeoutPrompt: kernel.actionById(`${outcome.timeoutRow.occurrenceId}:prompt`),
    timeoutStale: kernel.actionById(`${outcome.timeoutRow.occurrenceId}:stale`),
  }));
  // Zero watch-plane rows survive (the entity\u2019s own passivation `resume`
  // chain is loop-reserved bookkeeping, not a monitor arm).
  expect(after.armed.filter((row) => row.sourceKey === "monitor")).toEqual([]);
  expect(after.hitPrompt?.kind).toBe("prompt");
  expect(after.hitPrompt?.effect.value).toMatchObject({ content: [{ kind: "text", text: "DONE" }] });
  expect(after.timeoutPrompt).toBeUndefined();
  expect(after.timeoutStale?.kind).toBe("alarm");
});
