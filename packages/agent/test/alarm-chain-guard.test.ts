import { describe, expect, expectTypeOf, test } from "bun:test";
import { Effect } from "effect";
import { Alarm } from "@openomni/protocol";
import {
  alarmDisposition,
  armAction,
  firedAction,
  type AlarmArmView,
  type AlarmChainReads,
  type AlarmSkipReason,
} from "../src/core/ports/alarm";
import { composeAlarmPurposes } from "../src/plugins/alarm";
import {
  ArmRefused,
  AlarmWakeError,
  RESERVED_PURPOSES,
  type AlarmCapability,
  type AlarmFired,
  type AlarmWakeContext,
  type AlarmWakeOutcome,
  type ArmVerb,
} from "../src/core/api";
import { runAgent } from "./helpers/executor";

// One chain guard replaces the four per-purpose delivery guards
// (retry/deadline/watch). A delivered occurrence is fresh iff the
// latest arm row still names it, the arm is not retired, and no accepted
// firing settled it; everything else folds to a recorded skip.

function reads(input: {
  readonly arms?: Readonly<Record<string, AlarmArmView>>;
  readonly settled?: readonly string[];
}): AlarmChainReads {
  return {
    latestArm: (alarmId) => input.arms?.[alarmId],
    settled: (occurrenceId) => (input.settled ?? []).includes(occurrenceId),
  };
}

describe("alarmDisposition chain guard", () => {
  test("a superseded late arrival skips as superseded with zero execution", () => {
    const chain = reads({ arms: { "a-1": { occurrenceId: "occ-new", at: 9_000 } } });
    expect(alarmDisposition(chain, { alarmId: "a-1", occurrenceId: "occ-old" })).toEqual({
      op: "skip",
      reason: "superseded",
    });
  });

  test("a retired arm (at: null) skips its own occurrence as superseded", () => {
    const chain = reads({ arms: { "a-1": { occurrenceId: "occ-1", at: null } } });
    expect(alarmDisposition(chain, { alarmId: "a-1", occurrenceId: "occ-1" })).toEqual({
      op: "skip",
      reason: "superseded",
    });
  });

  test("an already settled occurrence skips as settled", () => {
    const chain = reads({
      arms: { "a-1": { occurrenceId: "occ-1", at: 9_000 } },
      settled: ["occ-1"],
    });
    expect(alarmDisposition(chain, { alarmId: "a-1", occurrenceId: "occ-1" })).toEqual({
      op: "skip",
      reason: "settled",
    });
  });

  test("an alarm with no committed arm chain skips as unknown", () => {
    expect(alarmDisposition(reads({}), { alarmId: "a-missing", occurrenceId: "occ-1" })).toEqual({
      op: "skip",
      reason: "unknown",
    });
  });

  test("a fresh occurrence on the latest live arm runs", () => {
    const chain = reads({ arms: { "a-1": { occurrenceId: "occ-1", at: 9_000 } } });
    expect(alarmDisposition(chain, { alarmId: "a-1", occurrenceId: "occ-1" })).toEqual({
      op: "run",
    });
  });
});

describe("alarm row builders", () => {
  test("armAction mints the occurrence from the journal sequence and pins the row shape", () => {
    const { action, occurrenceId } = armAction({
      parentId: "parent-1",
      sessionId: "session-1",
      purpose: "cron.tick",
      at: 60_000,
      supersedes: "occ-prev",
      alarmId: "cron-1",
      sourceKey: "cron",
      payload: { expr: "*/30 * * * *" },
      armSeq: 42,
      ts: 1_000,
    });
    expect(occurrenceId).toBe(Alarm.occurrenceId("session-1", "cron-1", 42, "cron"));
    expect(action.id).toBe("cron-1:arm:42");
    expect(action.kind).toBe("alarm");
    expect(action.intent).toEqual({
      encodingVersion: 1,
      value: {
        op: "arm",
        purpose: "cron.tick",
        at: 60_000,
        supersedes: "occ-prev",
        alarmId: "cron-1",
        sourceKey: "cron",
        payload: { expr: "*/30 * * * *" },
      },
    });
    expect(action.effect).toEqual({ encodingVersion: 1, value: { occurrenceId } });
  });

  test("firedAction preserves the outcome and keys the row on occurrence and outcome", () => {
    for (const outcome of ["delivered", "stale", "exhausted"] as const) {
      const action = firedAction({
        parentId: null,
        sessionId: "session-1",
        purpose: "retry",
        alarmId: "act-1:retry",
        occurrenceId: "occ-1",
        outcome,
        ts: 2_000,
      });
      expect(action.id).toBe(`occ-1:${outcome}`);
      expect(action.kind).toBe("alarm");
      expect(action.intent).toEqual({
        encodingVersion: 1,
        value: {
          op: "fired",
          occurrenceId: "occ-1",
          outcome,
          purpose: "retry",
          alarmId: "act-1:retry",
        },
      });
    }
  });
});

describe("composeAlarmPurposes registry", () => {
  test("rejects a capability declaring a reserved purpose with a typed compose error", async () => {
    for (const purpose of [...RESERVED_PURPOSES, "rescan"]) {
      const error = await runAgent(
        Effect.flip(
          composeAlarmPurposes({ capabilities: [{ bundle: "monitor", purposes: [purpose] }] }),
        ),
      );
      expect(error._tag).toBe("AlarmComposeError");
      expect(error.code).toBe("reserved_purpose");
      expect(error.purpose).toBe(purpose);
      expect(error.bundle).toBe("monitor");
    }
  });

  test("rejects a duplicate purpose across capabilities with a typed compose error", async () => {
    const error = await runAgent(
      Effect.flip(
        composeAlarmPurposes({
          capabilities: [
            { bundle: "cron", purposes: ["cron.tick"] },
            { bundle: "monitor", purposes: ["cron.tick"] },
          ],
        }),
      ),
    );
    expect(error.code).toBe("duplicate_purpose");
    expect(error.purpose).toBe("cron.tick");
    expect(error.bundle).toBe("monitor");
  });

  test("accepts a capability declaring cron.tick and keeps the reserved purposes present", async () => {
    const registry = await runAgent(
      composeAlarmPurposes({ capabilities: [{ bundle: "cron", purposes: ["cron.tick"] }] }),
    );
    expect(registry.get("cron.tick")).toBe("cron");
    for (const purpose of RESERVED_PURPOSES) expect(registry.get(purpose)).toBe("core");
  });
});

// Seam pin over core/api.ts (the plugin import surface): these names
// are frozen at S1 — later steps add, never rename. A capability's wake
// settles the accepted outcome through the core's firedAction — it returns
// the outcome, never an alarm literal.
describe("frozen alarm capability seam (core/api.ts)", () => {
  test("wake takes the fired view plus the wake context and returns the accepted outcome", () => {
    expectTypeOf<AlarmWakeOutcome>().toEqualTypeOf<"delivered" | "exhausted">();
    expectTypeOf<Parameters<AlarmCapability["wake"]>>().toEqualTypeOf<
      [AlarmFired, AlarmWakeContext]
    >();
    expectTypeOf<ReturnType<AlarmCapability["wake"]>>().toEqualTypeOf<
      Effect.Effect<AlarmWakeOutcome, AlarmWakeError>
    >();
    expectTypeOf<AlarmWakeContext["arm"]>().toEqualTypeOf<ArmVerb>();
    expectTypeOf<AlarmSkipReason>().toEqualTypeOf<"superseded" | "settled" | "unknown">();
  });

  test("arm refusals and wake failures are typed, never thrown strings", () => {
    const refused = new ArmRefused({ code: "alarm_budget" });
    expect(refused._tag).toBe("ArmRefused");
    expect(refused.code).toBe("alarm_budget");
    const wakeError = new AlarmWakeError({ purpose: "cron.tick", reason: "bundle off" });
    expect(wakeError._tag).toBe("AlarmWakeError");
    expect(wakeError.purpose).toBe("cron.tick");
  });

  test("the reserved purpose set is the four loop-consumed names", () => {
    expect([...RESERVED_PURPOSES]).toEqual(["step_watchdog", "retry", "deadline", "resume"]);
  });
});
