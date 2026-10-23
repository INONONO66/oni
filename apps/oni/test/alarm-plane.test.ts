import { expect, test } from "bun:test";
import { Bundle, Core } from "@oni/agent";
import { Effect, Result } from "effect";
import {
  alarmChainReads,
  createAlarmMonitorPorts,
  createLiveArmRegistry,
  foldAlarmChains,
  watchStateOf,
} from "../src/bundles/alarms/index";
import { runEffect, runSyncResult } from "./helpers/effect";
import {
  awaitScheduled,
  commitArm,
  FIXTURE_BASE,
  watchFixture,
  withEntityAlarmPorts,
} from "./helpers/watch-fixture";

const OWNER = "alarm-plane-owner";
const SESSION = "alarm-plane-session";

const watchSpec = (notificationLimit: number) => ({
  watch: { command: "true", description: "coverage", persistent: true as const },
  policyGeneration: 1,
  notificationLimit,
});

test("the live arm registry binds continuations to the authorizing activation's turn (H3)", async () => {
  const registry = createLiveArmRegistry();
  const armInput = {
    purpose: "monitor.hit",
    at: 1000,
    alarmId: "watch-1",
    sourceKey: "monitor",
    payload: {},
  };
  // No live activation: the app path commits nothing and refuses typed.
  const refused = await runEffect(Effect.flip(registry.arm(SESSION, "t1")(armInput)));
  expect(refused.code).toBe("not_live");
  // A registered activation's verb commits only for the turn it owns.
  const calls: string[] = [];
  const verbOf =
    (occurrenceId: string): Core.ArmVerb =>
    (input) =>
      Effect.sync(() => {
        calls.push(occurrenceId);
        return { alarmId: input.alarmId ?? "minted", occurrenceId, armSeq: 1 };
      });
  const release = registry.onLive(SESSION, {
    arm: verbOf("occ-old"),
    ownsTurn: (turnId) => turnId === "t1",
  });
  // A continuation minted under the old activation's turn t1 — NOT yet executed.
  const continuation = registry.arm(SESSION, "t1")(armInput);
  // The successor activation registers; it owns t2, never t1.
  registry.onLive(SESSION, { arm: verbOf("occ-new"), ownsTurn: (turnId) => turnId === "t2" });
  // Executing the stale continuation refuses stale_activation (r3 H1: the
  // activation binding is the primary guard): it is never re-resolved to the
  // successor and NEITHER verb commits anything.
  expect((await runEffect(Effect.flip(continuation))).code).toBe("stale_activation");
  expect(calls).toEqual([]);
  // The successor's own turn commits through the successor's verb.
  expect((await runEffect(registry.arm(SESSION, "t2")(armInput))).occurrenceId).toBe("occ-new");
  expect(calls).toEqual(["occ-new"]);
  // A stale release (prior activation) never evicts the newer registration.
  release();
  expect((await runEffect(registry.arm(SESSION, "t2")(armInput))).occurrenceId).toBe("occ-new");
  // Another session stays not_live.
  expect((await runEffect(Effect.flip(registry.arm("other-session", "t2")(armInput)))).code).toBe(
    "not_live",
  );
});

test("r3 H1: a recovered turn never lets an old activation's continuation borrow the successor", () => {
  const registry = createLiveArmRegistry();
  const armInput = {
    purpose: "monitor.hit",
    at: 1000,
    alarmId: "watch-1",
    sourceKey: "monitor",
    payload: {},
  };
  const calls: string[] = [];
  const verbOf =
    (occurrenceId: string): Core.ArmVerb =>
    (input) =>
      Effect.sync(() => {
        calls.push(occurrenceId);
        return { alarmId: input.alarmId ?? "minted", occurrenceId, armSeq: 1 };
      });
  // Recovery retains the open turn id (core/recovery resumeTurn): BOTH the old
  // activation and its successor own the SAME durable turn token.
  const ownsPersisted = (turnId: string) => turnId === "persisted-turn";
  registry.onLive(SESSION, { arm: verbOf("occ-old"), ownsTurn: ownsPersisted });
  // A continuation minted under the old activation — NOT yet executed.
  const continuation = registry.arm(SESSION, "persisted-turn")(armInput);
  // The successor activation recovers the same turn and registers.
  registry.onLive(SESSION, { arm: verbOf("occ-successor"), ownsTurn: ownsPersisted });
  // The zombie's deferred execution is a typed refusal: the successor's verb
  // is NEVER called and nothing is appended.
  const outcome = runSyncResult(continuation);
  expect(Result.isFailure(outcome) && outcome.failure.code).toBe("stale_activation");
  expect(calls).toEqual([]);
  // A verb created under the live successor still commits.
  const committed = runSyncResult(registry.arm(SESSION, "persisted-turn")(armInput));
  expect(Result.isSuccess(committed) && committed.success.occurrenceId).toBe("occ-successor");
  expect(calls).toEqual(["occ-successor"]);
});

test("r4 H1: a watch continuation built under the old activation never commits through the successor", () => {
  const registry = createLiveArmRegistry();
  const calls: string[] = [];
  const installs: string[] = [];
  const verbOf =
    (occurrenceId: string): Core.ArmVerb =>
    (input) =>
      Effect.sync(() => {
        calls.push(occurrenceId);
        return { alarmId: input.alarmId ?? "minted", occurrenceId, armSeq: 1 };
      });
  // Recovery retains the open turn id: BOTH activations own `persisted-turn`.
  const ownsPersisted = (turnId: string) => turnId === "persisted-turn";
  registry.onLive(SESSION, { arm: verbOf("occ-old"), ownsTurn: ownsPersisted });
  const watch = Bundle.createWatchVerb(registry.arm, {
    install: ({ watchId }) =>
      Effect.sync(() => {
        installs.push(watchId);
      }),
  });
  // The pending watch effect is BUILT under the old activation — NOT executed.
  const pending = watch({
    sessionId: SESSION,
    turnId: "persisted-turn",
    watchId: "watch-1",
    spec: watchSpec(1),
    now: 1,
  });
  // The successor activation recovers the same turn and registers.
  registry.onLive(SESSION, { arm: verbOf("occ-successor"), ownsTurn: ownsPersisted });
  // Executing the stale watch is a typed refusal through the COMPOSED verb
  // (r4 H1): the authorizing arm is minted at watch invocation, never
  // re-minted from the durable turn id after suspension — zero arm calls on
  // either activation, zero native installs.
  const outcome = runSyncResult(pending);
  expect(
    Result.isFailure(outcome) &&
      outcome.failure instanceof Core.ArmRefused &&
      outcome.failure.code,
  ).toBe("stale_activation");
  expect(calls).toEqual([]);
  expect(installs).toEqual([]);
  // A watch invoked under the live successor still arms and installs.
  const committed = runSyncResult(
    watch({
      sessionId: SESSION,
      turnId: "persisted-turn",
      watchId: "watch-2",
      spec: watchSpec(1),
      now: 1,
    }),
  );
  expect(Result.isSuccess(committed) && committed.success.occurrenceId).toBe("occ-successor");
  expect(calls).toEqual(["occ-successor"]);
  expect(installs).toEqual(["watch-2"]);
});

test("the chain fold pages full history and feeds the chain-guard reads", async () => {
  const state = await watchFixture(SESSION, OWNER);
  try {
    const first = await commitArm(state, SESSION, {
      purpose: "monitor.hit",
      at: 1000,
      alarmId: "paged",
      sourceKey: "monitor",
      payload: { spec: watchSpec(400), notifications: 0 },
    });
    // One 300-row fired batch pushes the second arm past the first history page.
    const row = state.kernel.row(SESSION);
    await runEffect(
      state.kernel.commit({
        sessionId: SESSION,
        owner: OWNER,
        fence: state.fence,
        now: 3000,
        expectedRevision: row.revision,
        actions: Array.from({ length: 300 }, (_: undefined, index) =>
          Core.firedAction({
            parentId: null,
            sessionId: SESSION,
            purpose: "monitor.hit",
            alarmId: "paged",
            occurrenceId: `${first.occurrenceId}:${index}`,
            outcome: "delivered",
            ts: 2000 + index,
          }),
        ),
        state: row.state,
      }),
    );
    const second = await commitArm(state, SESSION, {
      purpose: "monitor.hit",
      at: 4000,
      alarmId: "paged",
      supersedes: first.occurrenceId,
      sourceKey: "monitor",
      payload: { spec: watchSpec(400), notifications: 300 },
      ts: 4000,
    });
    const chain = foldAlarmChains(state.kernel, SESSION).get("paged");
    expect(chain?.latest.occurrenceId).toBe(second.occurrenceId);
    expect(chain?.armCount).toBe(2);
    expect(chain?.delivered).toBe(300);
    const reads = alarmChainReads(state.kernel, SESSION);
    expect(reads.latestArm("paged")).toEqual({ occurrenceId: second.occurrenceId, at: 4000 });
    expect(reads.settled(`${first.occurrenceId}:5`)).toBe(true);
    expect(reads.settled(second.occurrenceId)).toBe(false);
  } finally {
    state.plane.close();
  }
});

test("watchStateOf projects armed and retired chains from the latest arm payload", async () => {
  const state = await watchFixture(SESSION, OWNER);
  try {
    const armed = await commitArm(state, SESSION, {
      purpose: "monitor.hit",
      at: 1500,
      alarmId: "proj",
      sourceKey: "monitor",
      payload: { spec: watchSpec(4), notifications: 2 },
    });
    const chains = () => foldAlarmChains(state.kernel, SESSION);
    const live = chains().get("proj");
    if (live === undefined) throw new Error("missing chain");
    expect(watchStateOf(live, SESSION)).toMatchObject({
      id: "proj",
      kind: "watch",
      status: "armed",
      fireAt: 1500,
      notifications: 2,
      occurrenceId: armed.occurrenceId,
    });
    for (const [reason, status] of [
      ["cancel", "cancelled"],
      // #1254 r2 H2: the watch verb's create compensation retires with this reason.
      ["create", "cancelled"],
      ["exhausted", "exhausted"],
      ["fired", "fired"],
      ["timeout", "fired"],
    ] as const) {
      await commitArm(state, SESSION, {
        purpose: "monitor.hit",
        at: null,
        alarmId: "proj",
        supersedes: armed.occurrenceId,
        sourceKey: "monitor",
        payload: { reason },
      });
      const retired = chains().get("proj");
      if (retired === undefined) throw new Error("missing chain");
      expect(watchStateOf(retired, SESSION)).toMatchObject({ status, fireAt: null });
    }
    const cron = await commitArm(state, SESSION, {
      purpose: "cron.tick",
      at: 9000,
      alarmId: "tick",
      sourceKey: "cron",
      payload: { expr: "*/5 * * * *", tz: "UTC", description: "grid" },
    });
    const cronChain = chains().get("tick");
    if (cronChain === undefined) throw new Error("missing cron chain");
    expect(watchStateOf(cronChain, SESSION)).toMatchObject({
      kind: "cron",
      status: "armed",
      occurrenceId: cron.occurrenceId,
    });
  } finally {
    state.plane.close();
  }
});

test("monitor ports drive the watch lifecycle through the real entity's committing verb", async () => {
  await withEntityAlarmPorts("entity-lifecycle-session", async (fx) => {
    const signal = new AbortController().signal;
    const created = await fx.ports.create(
      {
        sessionId: fx.sessionId,
        turnId: fx.turnId,
        id: "lifecycle",
        kind: "watch",
        spec: {
          watch: { command: "true", description: "timed", timeout_ms: 500 },
          policyGeneration: 1,
          notificationLimit: 2,
        },
      },
      signal,
    );
    expect(created).toMatchObject({
      id: "lifecycle",
      kind: "watch",
      status: "armed",
      fireAt: FIXTURE_BASE,
      notifications: 0,
    });
    expect(fx.installed.map((spec) => spec.id)).toEqual(["lifecycle"]);
    // The timed watch armed its timeout chain; the ENTITY forwarded the
    // non-hit occurrence through the durable DeliverAt door.
    const timeoutChain = foldAlarmChains(fx.kernel, fx.sessionId).get("lifecycle:timeout");
    expect(timeoutChain?.latest.at).toBe(FIXTURE_BASE + 500);
    await awaitScheduled(fx.catalogFile, FIXTURE_BASE + 500);
    // A continuation under a turn the live activation does not own is
    // refused by the production registry — the entity appends nothing.
    const stale = await runEffect(
      Effect.flip(
        fx.registryArm(fx.sessionId, "some-other-turn")({
          purpose: "monitor.hit",
          at: FIXTURE_BASE + 9_000,
          alarmId: "stale-arm",
          sourceKey: "monitor",
          payload: {},
        }),
      ),
    );
    expect(stale.code).toBe("stale_turn");
    expect(foldAlarmChains(fx.kernel, fx.sessionId).get("stale-arm")).toBeUndefined();
    // Rearm of a live watch is a no-op: the armed chain stands.
    expect(
      await fx.ports.rearm("lifecycle", fx.sessionId, fx.turnId, FIXTURE_BASE, signal),
    ).toMatchObject({ status: "armed", occurrenceId: created.occurrenceId });
    // A chain the session never armed is refused, not cancelled.
    await expect(
      fx.ports.cancel("ghost", fx.sessionId, fx.turnId, FIXTURE_BASE, signal),
    ).rejects.toMatchObject({ _tag: "MonitorRefused" });
    const cancelled = await fx.ports.cancel("lifecycle", fx.sessionId, fx.turnId, FIXTURE_BASE, signal);
    expect(cancelled).toMatchObject({ status: "cancelled", fireAt: null });
    expect(fx.closed).toEqual(["lifecycle"]);
    // The timeout chain retired with its watch.
    const timeout = foldAlarmChains(fx.kernel, fx.sessionId).get("lifecycle:timeout");
    expect(timeout?.latest).toMatchObject({ at: null, payload: { reason: "cancel" } });
    // Rearm revives the retired chain from its last sealed spec and reinstalls.
    const revived = await fx.ports.rearm("lifecycle", fx.sessionId, fx.turnId, FIXTURE_BASE, signal);
    expect(revived).toMatchObject({ status: "armed", notifications: 0 });
    expect(revived.occurrenceId).not.toBe(created.occurrenceId);
    expect(fx.installed.map((spec) => spec.id)).toEqual(["lifecycle", "lifecycle"]);
  });
});

test("monitor ports arm and revive a cron chain on its grid through the real entity", async () => {
  await withEntityAlarmPorts("entity-cron-session", async (fx) => {
    const signal = new AbortController().signal;
    const created = await fx.ports.create(
      {
        sessionId: fx.sessionId,
        turnId: fx.turnId,
        id: "grid",
        kind: "cron",
        expr: "*/5 * * * *",
        tz: "UTC",
        description: "five",
      },
      signal,
    );
    // FIXTURE_BASE sits on a five-minute boundary; the next tick is +5min.
    expect(created).toMatchObject({
      id: "grid",
      kind: "cron",
      status: "armed",
      fireAt: FIXTURE_BASE + 300_000,
    });
    await awaitScheduled(fx.catalogFile, FIXTURE_BASE + 300_000);
    // Native sources never track cron chains.
    expect(fx.installed).toEqual([]);
    const cancelled = await fx.ports.cancel("grid", fx.sessionId, fx.turnId, FIXTURE_BASE, signal);
    expect(cancelled).toMatchObject({ status: "cancelled", fireAt: null });
    const revived = await fx.ports.rearm(
      "grid",
      fx.sessionId,
      fx.turnId,
      FIXTURE_BASE + 400_000,
      signal,
    );
    expect(revived).toMatchObject({ status: "armed", fireAt: FIXTURE_BASE + 600_000 });
    await awaitScheduled(fx.catalogFile, FIXTURE_BASE + 600_000);
  });
});

test("r5 H1: cancel's timeout retire never borrows a successor activation's authority", async () => {
  await withEntityAlarmPorts("entity-cancel-stale-session", async (fx) => {
    const signal = new AbortController().signal;
    await fx.ports.create(
      {
        sessionId: fx.sessionId,
        turnId: fx.turnId,
        id: "watch",
        kind: "watch",
        spec: {
          watch: { command: "true", description: "timed", timeout_ms: 500 },
          policyGeneration: 1,
          notificationLimit: 2,
        },
      },
      signal,
    );
    // Recovery keeps the durable turn id: BOTH activations own fx.turnId.
    const registry = createLiveArmRegistry();
    const calls: Array<readonly [string, string]> = [];
    const successor = {
      ownsTurn: (turnId: string) => turnId === fx.turnId,
      arm: ((input) =>
        Effect.sync(() => {
          calls.push(["successor", input.alarmId ?? "minted"]);
          return { alarmId: input.alarmId ?? "minted", occurrenceId: "successor", armSeq: 1 };
        })) satisfies Core.ArmVerb,
    };
    // The old activation commits through the REAL entity verb; completing the
    // main-chain retire replaces the live entry with a successor owning the
    // SAME recovered turn — exactly the window between cancel's two awaits.
    registry.onLive(fx.sessionId, {
      ownsTurn: (turnId) => turnId === fx.turnId,
      arm: (input) =>
        fx.entityArm(input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              calls.push(["old", input.alarmId ?? "minted"]);
              registry.onLive(fx.sessionId, successor);
            }),
          ),
        ),
    });
    const ports = createAlarmMonitorPorts({
      capability: { ...fx.capability, verbs: { ...fx.capability.verbs, arm: registry.arm } },
      readSession: fx.plane.openKernel,
      clock: () => FIXTURE_BASE,
      entropy: () => "unused",
      run: (effect) => runEffect(effect),
    });
    // The stale cancel continuation is a typed refusal (retire maps the
    // ArmRefused code into the thrown Error): ONE arm verb is minted at
    // cancel invocation, so the timeout retire never re-resolves authority.
    await expect(
      ports.cancel("watch", fx.sessionId, fx.turnId, FIXTURE_BASE, signal),
    ).rejects.toMatchObject({ message: "stale_activation" });
    // The successor's verb never ran — the only commit went through the old
    // activation's entity verb for the main chain.
    expect(calls).toEqual([["old", "watch"]]);
    // The timeout chain was NOT retired through the successor: it stands armed.
    const timeout = foldAlarmChains(fx.kernel, fx.sessionId).get("watch:timeout");
    expect(timeout?.latest.at).toBe(FIXTURE_BASE + 500);
  });
});
