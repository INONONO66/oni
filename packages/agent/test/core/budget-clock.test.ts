import { describe, expect, it } from "bun:test";
import { Operational } from "@oni/protocol";
import { collector } from "../helpers/observation-collector";
import { createBudgetState, evaluateBudget, publishBudgetTelemetry } from "../../src/core/loop/budget";
import { testBudget } from "../helpers/approval-policy";

/**
 * The wall-time budget reads only the injected clock. The ceiling is a
 * closed bound — the budget expires exactly when the injected clock crosses
 * `maxWallTimeMs`, and not one millisecond before.
 */
describe("wall-time budget ceiling on the injected clock", () => {
  const budget = testBudget({ maxWallTimeMs: 100 });

  it("expires exactly when the injected clock crosses the ceiling, not one ms before", () => {
    let time = 0;
    const now = () => time;
    const state = createBudgetState(now);

    time = 99;
    const oneMsBefore = evaluateBudget(state, now, budget);
    expect(oneMsBefore.status).not.toBe("exceeded");
    expect(oneMsBefore.elapsedMs).toBe(99);
    expect(oneMsBefore.exceededLimit).toBeUndefined();

    time = 100;
    const atCeiling = evaluateBudget(state, now, budget);
    expect(atCeiling).toMatchObject({
      status: "exceeded",
      elapsedMs: 100,
      exceededLimit: "wall time",
    });
  });

  it("publishes the exceeded record only at the crossing, stamped with the injected time", () => {
    let time = 0;
    const now = () => time;
    const state = createBudgetState(now);
    const run = { traceId: "trace-budget-clock", sessionId: "session-budget-clock" };
    const events = collector();
    const exceededRecords = () =>
      events
        .named(Operational.Events.Warn.name)
        .filter((event) => Operational.Events.Warn.schema.parse(event).context?.type === "exceeded");

    time = 99;
    expect(publishBudgetTelemetry(state, run, events, now, budget)).not.toBe("exceeded");
    expect(exceededRecords()).toHaveLength(0);

    time = 100;
    expect(publishBudgetTelemetry(state, run, events, now, budget)).toBe("exceeded");
    expect(exceededRecords()).toHaveLength(1);
    expect(exceededRecords()[0]).toMatchObject({
      traceId: run.traceId,
      sessionId: run.sessionId,
      time: 100,
      msg: "budget exceeded: wall time",
    });
  });
});
