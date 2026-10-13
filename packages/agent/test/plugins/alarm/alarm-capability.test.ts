import { describe, expect, test } from "bun:test";
import { runTestSync } from "../../helpers/isolated";
import { Effect, Logger } from "effect";
import type { Alarm } from "@openomni/protocol";
import { AlarmComposeError, composeAlarmPurposes } from "../../../src/core/alarm";
import { AlarmWakeError, ArmRefused, type ArmVerb } from "../../../src/core/api";
import { alarmCapability, MONITOR_HIT, MONITOR_SOURCE, MONITOR_TIMEOUT, watchPurposes, WatchRefused } from "../../../src/plugins/alarm";
import {
  fired,
  stubArm,
  stubCapability as capability,
  stubContext,
  WATCH_SPEC as spec,
  wakeHit,
  wakeTimeout,
  watchVerb,
  type ArmCall,
  type ChainRows,
  type PromptCall,
} from "../../helpers/alarm-capability";

// #1254 P1: the removable alarm capability — purpose registry through Lane
// 1's compose, wake dispatch, the watch handlers over the supersedes
// lifecycle (no generation counter), and the guarded arm/watch verbs. Pure functions and
// stubbed AlarmWakeContext; Lane 4 wires the live dispatch.

describe("purpose registry through composeAlarmPurposes", () => {
  test("a reserved purpose declaration refuses the whole capability", () => {
    const build = alarmCapability({
      bundles: [
        {
          bundle: "rogue",
          purposes: [{ name: "retry", handler: () => Effect.succeed("delivered" as const) }],
        },
      ],
      compose: composeAlarmPurposes,
      arm: () => stubArm([]),
      watch: { install: () => Effect.void },
    });
    const error = runTestSync(Effect.flip(build));
    expect(error).toBeInstanceOf(AlarmComposeError);
    expect(error.code).toBe("reserved_purpose");
    expect(error.bundle).toBe("rogue");
  });

  test("a duplicate purpose across bundles refuses with the duplicating bundle", () => {
    const build = alarmCapability({
      bundles: [
        {
          bundle: "monitor",
          purposes: watchPurposes({ close: () => undefined }),
        },
        {
          bundle: "copycat",
          purposes: [{ name: MONITOR_HIT, handler: () => Effect.succeed("delivered" as const) }],
        },
      ],
      compose: composeAlarmPurposes,
      arm: () => stubArm([]),
      watch: { install: () => Effect.void },
    });
    const error = runTestSync(Effect.flip(build));
    expect(error.code).toBe("duplicate_purpose");
    expect(error.bundle).toBe("copycat");
  });

  test("the composed definition names its registry, point, and declared purposes", () => {
    const definition = capability({ arm: stubArm([]), extra: [{ bundle: "cron", purposes: ["cron.tick"] }] });
    expect(definition.name).toBe("alarm");
    expect(definition.points).toEqual(["alarm.fired"]);
    expect([...definition.purposes].sort()).toEqual(["cron.tick", MONITOR_HIT, MONITOR_TIMEOUT].sort());
    expect(definition.registry.get(MONITOR_HIT)).toBe("monitor");
    expect(definition.registry.get("cron.tick")).toBe("cron");
    expect(definition.registry.get("retry")).toBe("core");
  });
});

describe("wake dispatch", () => {
  test("routes a fired occurrence to its registered handler", () => {
    const prompts: PromptCall[] = [];
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm(calls) });
    const outcome = runTestSync(
      wakeHit(
        definition,
        { notifications: 0, hit: { content: "line one", terminal: false, detail: "line:1" } },
        stubContext({ arm: stubArm(calls), prompts }),
      ),
    );
    expect(outcome).toBe("delivered");
    expect(prompts).toEqual([{ content: "line one" }]);
  });

  test("an unregistered purpose is a typed wake failure with zero handler calls", () => {
    const prompts: PromptCall[] = [];
    const definition = capability({ arm: stubArm([]) });
    const error = runTestSync(
      Effect.flip(
        definition.wake(
          fired({ purpose: "reminder.due", payload: "{}" }),
          stubContext({ arm: stubArm([]), prompts }),
        ),
      ),
    );
    expect(error).toBeInstanceOf(AlarmWakeError);
    expect(error.reason).toBe("unregistered_purpose");
    expect(prompts).toEqual([]);
  });
});

describe("monitor.hit over the supersedes lifecycle", () => {
  test("a non-terminal hit under budget prompts and re-arms superseding the fired occurrence", () => {
    const prompts: PromptCall[] = [];
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm([]) });
    const outcome = runTestSync(
      wakeHit(
        definition,
        { spec: { ...spec, notificationLimit: 3 }, notifications: 0, hit: { content: "tick", terminal: false, detail: "line:1" } },
        stubContext({ arm: stubArm(calls), prompts }),
      ),
    );
    expect(outcome).toBe("delivered");
    expect(prompts).toEqual([{ content: "tick" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      purpose: MONITOR_HIT,
      at: 5_000,
      alarmId: "watch-1",
      supersedes: "occ-live",
      sourceKey: MONITOR_SOURCE,
      payload: { notifications: 1 },
    });
  });

  test("budget exhaustion returns exhausted and retires the chain", () => {
    const prompts: PromptCall[] = [];
    const closed: string[] = [];
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm([]), closed });
    const outcome = runTestSync(
      wakeHit(
        definition,
        { notifications: 1, hit: { content: "last", terminal: false, detail: "line:2" } },
        stubContext({ arm: stubArm(calls), prompts }),
      ),
    );
    expect(outcome).toBe("exhausted");
    expect(calls).toEqual([
      {
        purpose: MONITOR_HIT,
        at: null,
        alarmId: "watch-1",
        supersedes: "occ-live",
        sourceKey: MONITOR_SOURCE,
        payload: { reason: "exhausted" },
      },
    ]);
    expect(closed).toEqual(["watch-1"]);
    expect(prompts).toHaveLength(1);
  });

  test("a terminal hit retires the chain and closes the source", () => {
    const closed: string[] = [];
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm([]), closed });
    const outcome = runTestSync(
      wakeHit(
        definition,
        { notifications: 0, hit: { content: "exit 0", terminal: true, detail: "exit" } },
        stubContext({ arm: stubArm(calls) }),
      ),
    );
    expect(outcome).toBe("delivered");
    expect(calls[0]).toMatchObject({ at: null, payload: { reason: "fired" } });
    expect(closed).toEqual(["watch-1"]);
  });

  test("a terminal hit retires the armed timeout companion with the main chain", () => {
    const closed: string[] = [];
    const calls: ArmCall[] = [];
    const chains: ChainRows = {
      "watch-1": { occurrenceId: "occ-live", at: 4_000 },
      "watch-1:timeout": { occurrenceId: "occ-timeout", at: 65_000 },
    };
    const definition = capability({ arm: stubArm([]), closed });
    const outcome = runTestSync(
      wakeHit(
        definition,
        { notifications: 0, hit: { content: "exit 0", terminal: true, detail: "exit" } },
        stubContext({ arm: stubArm(calls, undefined, chains), chains }),
      ),
    );
    expect(outcome).toBe("delivered");
    expect(calls.map((call) => [call.purpose, call.at, call.alarmId, call.supersedes])).toEqual([
      [MONITOR_HIT, null, "watch-1", "occ-live"],
      [MONITOR_TIMEOUT, null, "watch-1:timeout", "occ-timeout"],
    ]);
    expect(calls[1]?.payload).toEqual({ watchId: "watch-1" });
    expect(chains["watch-1"]?.at).toBeNull();
    expect(chains["watch-1:timeout"]?.at).toBeNull();
    expect(closed).toEqual(["watch-1"]);
  });

  test("budget exhaustion retires the armed timeout companion with the main chain", () => {
    const closed: string[] = [];
    const calls: ArmCall[] = [];
    const chains: ChainRows = {
      "watch-1": { occurrenceId: "occ-live", at: 4_000 },
      "watch-1:timeout": { occurrenceId: "occ-timeout", at: 65_000 },
    };
    const definition = capability({ arm: stubArm([]), closed });
    const outcome = runTestSync(
      wakeHit(
        definition,
        { notifications: 1, hit: { content: "last", terminal: false, detail: "line:2" } },
        stubContext({ arm: stubArm(calls, undefined, chains), chains }),
      ),
    );
    expect(outcome).toBe("exhausted");
    expect(calls.map((call) => [call.purpose, call.at, call.alarmId, call.supersedes])).toEqual([
      [MONITOR_HIT, null, "watch-1", "occ-live"],
      [MONITOR_TIMEOUT, null, "watch-1:timeout", "occ-timeout"],
    ]);
    expect(chains["watch-1:timeout"]?.at).toBeNull();
    expect(closed).toEqual(["watch-1"]);
  });

  test("a hit without native detail is a typed wake failure", () => {
    const definition = capability({ arm: stubArm([]) });
    const error = runTestSync(
      Effect.flip(
        wakeHit(
          definition,
          { notifications: 0 },
          stubContext({ arm: stubArm([]) }),
        ),
      ),
    );
    expect(error.reason).toBe("missing_hit");
  });

  test("an arm refusal during re-arm surfaces as a typed wake failure", () => {
    const definition = capability({ arm: stubArm([]) });
    const error = runTestSync(
      Effect.flip(
        wakeHit(
          definition,
          { spec: { ...spec, notificationLimit: 3 }, notifications: 0, hit: { content: "tick", terminal: false, detail: "line:1" } },
          stubContext({ arm: stubArm([], new ArmRefused({ code: "alarm_budget" })) }),
        ),
      ),
    );
    expect(error).toBeInstanceOf(AlarmWakeError);
    expect(error.reason).toBe("alarm_budget");
  });
});

describe("monitor.timeout", () => {
  test("prompts, retires the main chain through the chain reads, and closes the source", () => {
    const prompts: PromptCall[] = [];
    const closed: string[] = [];
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm([]), closed });
    const outcome = runTestSync(
      wakeTimeout(definition, stubContext({
          arm: stubArm(calls),
          prompts,
          chains: { "watch-1": { occurrenceId: "occ-main", at: 4_500 } },
        })),
    );
    expect(outcome).toBe("delivered");
    expect(calls).toEqual([
      {
        purpose: MONITOR_HIT,
        at: null,
        alarmId: "watch-1",
        supersedes: "occ-main",
        sourceKey: MONITOR_SOURCE,
        payload: { reason: "timeout" },
      },
    ]);
    expect(closed).toEqual(["watch-1"]);
    expect(JSON.parse(prompts[0]?.content ?? "{}")).toEqual({
      watchId: "watch-1",
      reason: "timeout",
    });
  });

  test("a timeout for a settled watch appends no prompt, arms nothing, and lapses as exhausted", () => {
    const prompts: PromptCall[] = [];
    const calls: ArmCall[] = [];
    const closed: string[] = [];
    const definition = capability({ arm: stubArm([]), closed });
    const outcome = runTestSync(
      wakeTimeout(definition, stubContext({
          arm: stubArm(calls),
          prompts,
          chains: { "watch-1": { occurrenceId: "occ-main", at: null } },
        })),
    );
    expect(outcome).toBe("exhausted");
    expect(prompts).toEqual([]);
    expect(calls).toEqual([]);
    expect(closed).toEqual([]);
  });
});

describe("verbs", () => {
  test("watch arms the chain, arms the timeout alarm, and installs the native source", () => {
    const calls: ArmCall[] = [];
    const installs: string[] = [];
    const definition = capability({ arm: stubArm(calls), installs });
    const result = runTestSync(
      watchVerb(definition),
    );
    expect(result).toEqual({ alarmId: "watch-9", occurrenceId: "occ-1", armSeq: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      purpose: MONITOR_HIT,
      at: 1_000,
      alarmId: "watch-9",
      sourceKey: MONITOR_SOURCE,
      payload: { notifications: 0 },
    });
    expect(calls[1]).toMatchObject({
      purpose: MONITOR_TIMEOUT,
      at: 61_000,
      alarmId: "watch-9:timeout",
      payload: { watchId: "watch-9" },
    });
    expect(installs).toEqual(["watch-9"]);
  });

  test("a refused timeout arm retires the already-committed main chain and surfaces the original refusal (r2 H2)", () => {
    const calls: ArmCall[] = [];
    const installs: string[] = [];
    let armSeq = 0;
    // The main arm takes the last budget slot; the timeout arm is the refusal.
    const boundaryArm: ArmVerb = (input) => {
      if (input.purpose === MONITOR_TIMEOUT && input.at !== null)
        return Effect.fail(new ArmRefused({ code: "alarm_budget" }));
      calls.push(input);
      armSeq += 1;
      return Effect.succeed({
        alarmId: input.alarmId ?? "minted-alarm",
        occurrenceId: `occ-${armSeq}`,
        armSeq,
      });
    };
    const definition = capability({ arm: boundaryArm, installs });
    const error = runTestSync(
      Effect.flip(
        watchVerb(definition),
      ),
    );
    expect(error).toBeInstanceOf(ArmRefused);
    expect((error as ArmRefused).code).toBe("alarm_budget");
    // The committed main chain retired superseding its own occurrence; the
    // never-committed timeout chain got no retire and the install never ran.
    expect(calls.map((call) => [call.purpose, call.at, call.alarmId, call.supersedes])).toEqual([
      [MONITOR_HIT, 1_000, "watch-9", undefined],
      [MONITOR_HIT, null, "watch-9", "occ-1"],
    ]);
    expect(calls[1]?.payload).toEqual({ reason: "create" });
    expect(installs).toEqual([]);
  });

  test("a refused compensating retire is logged, never masks the original refusal, and the install still never runs (r2 H2)", () => {
    const calls: ArmCall[] = [];
    const installs: string[] = [];
    const logged: string[] = [];
    let armSeq = 0;
    // Main arm commits; the timeout arm refuses; the compensating retire of
    // the main chain (at: null) refuses too — the double-refusal branch.
    const doubleRefusal: ArmVerb = (input) => {
      calls.push(input);
      if (input.purpose === MONITOR_TIMEOUT) return Effect.fail(new ArmRefused({ code: "alarm_budget" }));
      if (input.at === null) return Effect.fail(new ArmRefused({ code: "stale_activation" }));
      armSeq += 1;
      return Effect.succeed({ alarmId: input.alarmId ?? "minted-alarm", occurrenceId: `occ-${armSeq}`, armSeq });
    };
    const warnings = Logger.make((options) => {
      for (const item of Array.isArray(options.message) ? options.message : [options.message]) {
        if (typeof item === "string" && options.logLevel === "Warn") logged.push(item);
      }
    });
    const definition = capability({ arm: doubleRefusal, installs });
    const error = runTestSync(
      Effect.flip(
        watchVerb(definition),
      ).pipe(Effect.provide(Logger.layer([warnings]))),
    );
    expect(error).toBeInstanceOf(ArmRefused);
    // The ORIGINAL refusal reaches the caller, not the compensation's.
    expect((error as ArmRefused).code).toBe("alarm_budget");
    expect(calls.map((call) => [call.purpose, call.at, call.alarmId])).toEqual([
      [MONITOR_HIT, 1_000, "watch-9"],
      [MONITOR_TIMEOUT, 61_000, "watch-9:timeout"],
      [MONITOR_HIT, null, "watch-9"],
    ]);
    // Exactly one warning, carrying the injected sentinel code (no prose pin).
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("stale_activation");
    expect(installs).toEqual([]);
  });

  test("a refused native install retires the armed chain and its timeout, then surfaces the refusal", () => {
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm(calls), refuseInstall: "no machines plane" });
    const error = runTestSync(
      Effect.flip(
        watchVerb(definition),
      ),
    );
    expect(error).toBeInstanceOf(WatchRefused);
    expect((error as WatchRefused).reason).toBe("no machines plane");
    // arm hit, arm timeout, retire hit (superseding the armed occurrence), retire timeout.
    expect(calls.map((call) => [call.purpose, call.at, call.alarmId, call.supersedes])).toEqual([
      [MONITOR_HIT, 1_000, "watch-9", undefined],
      [MONITOR_TIMEOUT, 61_000, "watch-9:timeout", undefined],
      [MONITOR_HIT, null, "watch-9", "occ-1"],
      [MONITOR_TIMEOUT, null, "watch-9:timeout", "occ-2"],
    ]);
    expect(calls[2]?.payload).toEqual({ reason: "install" });
  });

  test("an invalid watch spec is a typed refusal with zero arms", () => {
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm(calls) });
    const broken = {
      ...spec,
      watch: { command: "", description: "broken", persistent: true },
    } as Alarm.WatchSpec;
    const error = runTestSync(
      Effect.flip(
        definition.verbs.watch({ sessionId: "session-1", turnId: "turn-1", watchId: "w", spec: broken, now: 0 }),
      ),
    );
    expect(error).toBeInstanceOf(WatchRefused);
    expect(calls).toEqual([]);
  });

  test("arm refuses reserved, rescan, and unregistered purposes before the commit path", () => {
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm(calls) });
    const refused = (purpose: string) =>
      runTestSync(
        Effect.flip(
          definition.verbs.arm("session-1", "turn-1")({ purpose, at: 1, payload: {}, sourceKey: "monitor" }),
        ),
      );
    expect(refused("retry").code).toBe("reserved_purpose");
    expect(refused("rescan").code).toBe("reserved_purpose");
    expect(refused("reminder.due").code).toBe("unknown_purpose");
    expect(calls).toEqual([]);
    const accepted = runTestSync(
      definition.verbs.arm("session-1", "turn-1")({
        purpose: MONITOR_HIT,
        at: 2,
        payload: {},
        alarmId: "watch-2",
        sourceKey: MONITOR_SOURCE,
      }),
    );
    expect(accepted.alarmId).toBe("watch-2");
    expect(calls).toHaveLength(1);
  });
});
