import { describe, expect, it } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Bus } from "../helpers/bus";
import { collector } from "../helpers/observation-collector";
import { captureBusEvents } from "../helpers/bus-event";
import {
  evaluateBudget,
  describeBudgetRemaining,
  createBudgetState,
  effectiveBudgetThresholds,
  publishBudgetTelemetry,
  recordTokenUsage,
} from "../../src/core/loop/budget";
import { TEST_BUDGET, testBudget } from "../helpers/approval-policy";

/** The run whose budget is being reported; the reporter never mints one. */
const TEST_RUN = { traceId: "trace-budget-test", sessionId: "session-budget-test" };

/** Fixed injected clock: elapsed wall time is always zero unless a test moves it. */
const now = () => 0;

function countCollectedOperationalEmits(
  run: (events: ReturnType<typeof collector>) => void,
): number {
  const events = collector();
  run(events);
  return (
    events.named(Operational.Events.Warn.name).length +
    events.named(Operational.Events.Info.name).length
  );
}

async function countGlobalOperationalEmits(run: () => void): Promise<number> {
  let seen = 0;
  const sentinel = {
    traceId: "trace-budget-test-barrier",
    time: 0,
    component: "agent.test",
    msg: "budget telemetry barrier",
  };
  let resolveBarrier: () => void = () => undefined;
  let barrierTimer: ReturnType<typeof setTimeout> | undefined;
  const barrier = new Promise<void>((resolve, reject) => {
    resolveBarrier = resolve;
    barrierTimer = setTimeout(() => reject(new Error("timed out waiting for Bus barrier")), 1_000);
  });
  const unsubWarn = Bus.subscribe(Operational.Events.Warn, () => {
    seen += 1;
  });
  const unsubInfo = Bus.subscribe(Operational.Events.Info, (event) => {
    if (event === sentinel) resolveBarrier();
    else seen += 1;
  });

  try {
    run();
    // Bus handlers are FIFO microtasks. Observing this subscribed sentinel
    // proves every operational event published by run() has been delivered.
    Bus.publish(Operational.Events.Info, sentinel);
    await barrier;
    return seen;
  } finally {
    if (barrierTimer !== undefined) clearTimeout(barrierTimer);
    unsubWarn();
    unsubInfo();
  }
}

describe("effectiveBudgetThresholds", () => {
  it("uses protocol-owned defaults and runtime-local resolution", () => {
    expect(effectiveBudgetThresholds()).toEqual({
      reassuranceThreshold: 0.6,
      warningThreshold: 0.8,
    });
    expect(effectiveBudgetThresholds({ warningThreshold: 0.9 })).toEqual({
      reassuranceThreshold: 0.6,
      warningThreshold: 0.9,
    });
  });
});

describe("budget telemetry 4-state", () => {
  it("returns ok when below reassurance threshold", () => {
    const s = { ...createBudgetState(now), turns: 12 };
    expect(publishBudgetTelemetry(s, TEST_RUN, collector(), now, testBudget({ maxTurns: 24 }))).toBe("ok");
  });

  it("returns reassurance when between reassurance and warning thresholds", () => {
    const s = { ...createBudgetState(now), turns: 15 };
    expect(publishBudgetTelemetry(s, TEST_RUN, collector(), now, testBudget({ maxTurns: 24 }))).toBe("reassurance");
  });

  it("returns warning when between warning and exceeded thresholds", () => {
    const s = { ...createBudgetState(now), turns: 20 };
    expect(publishBudgetTelemetry(s, TEST_RUN, collector(), now, testBudget({ maxTurns: 24 }))).toBe("warning");
  });

  it("returns exceeded when at limit", () => {
    const s = { ...createBudgetState(now), turns: 24 };
    expect(publishBudgetTelemetry(s, TEST_RUN, collector(), now, testBudget({ maxTurns: 24 }))).toBe("exceeded");
  });

  it("returns exceeded when tool runtime reaches its limit", () => {
    const s = { ...createBudgetState(now), toolRuntimeMs: 500 };
    expect(
      publishBudgetTelemetry(s, TEST_RUN, collector(), now, testBudget({
        maxTurns: -1,
        maxToolCalls: -1,
        maxWallTimeMs: -1,
        maxToolRuntimeMs: 500,
      })),
    ).toBe("exceeded");
  });

  it("maxTurns -1 allows unlimited turns", () => {
    const s = { ...createBudgetState(now), turns: 1000 };
    expect(publishBudgetTelemetry(s, TEST_RUN, collector(), now, testBudget({ maxTurns: -1 }))).toBe("ok");
  });

  it("maxTurns -1 with maxToolCalls limit uses only toolCalls ratio", () => {
    const s = { ...createBudgetState(now), turns: 1000, toolCalls: 9 };
    expect(
      publishBudgetTelemetry(s, TEST_RUN, collector(), now, testBudget({ maxTurns: -1, maxToolCalls: 10 })),
    ).toBe("warning");
  });

  it("all limits -1 always returns ok", () => {
    const s = { ...createBudgetState(now), turns: 1000, toolCalls: 1000, toolRuntimeMs: 1000000 };
    expect(
      publishBudgetTelemetry(s, TEST_RUN, collector(), now, testBudget({
        maxTurns: -1,
        maxToolCalls: -1,
        maxWallTimeMs: -1,
        maxToolRuntimeMs: -1,
      })),
    ).toBe("ok");
  });

  it("the resolved fixture defaults stay below every threshold at a fresh state", () => {
    expect(publishBudgetTelemetry(createBudgetState(now), TEST_RUN, collector(), now, TEST_BUDGET)).toBe("ok");
  });

  it("custom thresholds override defaults", () => {
    const s = { ...createBudgetState(now), turns: 18 };
    expect(
      publishBudgetTelemetry(s, TEST_RUN, collector(), now, testBudget({
        maxTurns: 24,
        warningThreshold: 0.9,
        reassuranceThreshold: 0.7,
      })),
    ).toBe("reassurance");
  });
});

describe("budget telemetry does not publish outside its supplied sink", () => {
  it("emits no telemetry even called twice at the warning threshold", async () => {
    const s = { ...createBudgetState(now), turns: 20 };
    const emits = await countGlobalOperationalEmits(() => {
      publishBudgetTelemetry(s, TEST_RUN, collector(), now, testBudget({ maxTurns: 24 }));
      publishBudgetTelemetry(s, TEST_RUN, collector(), now, testBudget({ maxTurns: 24 }));
    });
    expect(emits).toBe(0);
  });

  it("emits no telemetry at the exceeded threshold", async () => {
    const s = { ...createBudgetState(now), turns: 24 };
    const emits = await countGlobalOperationalEmits(() => {
      publishBudgetTelemetry(s, TEST_RUN, collector(), now, testBudget({ maxTurns: 24 }));
    });
    expect(emits).toBe(0);
  });
});

describe("publishBudgetTelemetry is the command (emits once, returns status)", () => {
  /** Budget reporting files every non-ok state under the run that caused it. */
  it.each([
    { name: "warning", turns: 20, event: Operational.Events.Warn, status: "warning" },
    { name: "reassurance", turns: 15, event: Operational.Events.Info, status: "reassurance" },
    { name: "exceeded", turns: 30, event: Operational.Events.Warn, status: "exceeded" },
  ] as const)("files the $name event under the run's trace", async ({ turns, event, status }) => {
    const capture = captureBusEvents(event);
    try {
      expect(
        publishBudgetTelemetry({ ...createBudgetState(now), turns }, TEST_RUN, Bus, now, testBudget({ maxTurns: 24 })),
      ).toBe(status);
      const [seen] = await capture.done;
      expect(capture.events).toHaveLength(1);
      expect(seen).toMatchObject({ traceId: TEST_RUN.traceId, sessionId: TEST_RUN.sessionId });
    } finally {
      capture.unsubscribe();
    }
  });

  it("emits exactly one event per call at the warning threshold", async () => {
    const s = { ...createBudgetState(now), turns: 20 };
    let status: string | undefined;
    const emits = countCollectedOperationalEmits((events) => {
      status = publishBudgetTelemetry(s, TEST_RUN, events, now, testBudget({ maxTurns: 24 }));
    });
    expect(status).toBe("warning");
    expect(emits).toBe(1);
  });

  it("emits nothing below the reassurance threshold", async () => {
    const s = { ...createBudgetState(now), turns: 5 };
    let status: string | undefined;
    const emits = countCollectedOperationalEmits((events) => {
      status = publishBudgetTelemetry(s, TEST_RUN, events, now, testBudget({ maxTurns: 24 }));
    });
    expect(status).toBe("ok");
    expect(emits).toBe(0);
  });
});

describe("describeBudgetRemaining", () => {
  it("includes turns remaining", () => {
    const s = { ...createBudgetState(now), turns: 5 };
    const desc = describeBudgetRemaining(s, now, testBudget({ maxTurns: 24 }));
    expect(desc).toContain("19 turns remaining");
  });

  it("displays unlimited when maxTurns is -1", () => {
    const s = { ...createBudgetState(now), turns: 5 };
    const desc = describeBudgetRemaining(s, now, testBudget({ maxTurns: -1 }));
    expect(desc).toContain("unlimited turns remaining");
  });

  it("singular turn when 1 remaining", () => {
    const s = { ...createBudgetState(now), turns: 23 };
    const desc = describeBudgetRemaining(s, now, testBudget({ maxTurns: 24 }));
    expect(desc).toContain("1 turn remaining");
    expect(desc).not.toContain("turns");
  });
});

describe("resolved default budget ceilings (#1309: values are policy-owned)", () => {
  it("enforces the default turn ceiling at 24", () => {
    expect(evaluateBudget({ ...createBudgetState(now), turns: 24 }, now, TEST_BUDGET)).toMatchObject({
      status: "exceeded",
      exceededLimit: "turns",
    });
    expect(evaluateBudget({ ...createBudgetState(now), turns: 23 }, now, TEST_BUDGET).status).toBe("warning");
  });

  it("enforces the default tool-call ceiling at 40", () => {
    expect(evaluateBudget({ ...createBudgetState(now), toolCalls: 40 }, now, TEST_BUDGET)).toMatchObject({
      status: "exceeded",
      exceededLimit: "tool calls",
    });
    expect(evaluateBudget({ ...createBudgetState(now), toolCalls: 39 }, now, TEST_BUDGET).status).toBe("warning");
  });

  it("enforces the default tool-runtime ceiling at two minutes", () => {
    expect(evaluateBudget({ ...createBudgetState(now), toolRuntimeMs: 120_000 }, now, TEST_BUDGET)).toMatchObject({
      status: "exceeded",
      exceededLimit: "tool wall time",
    });
    expect(evaluateBudget({ ...createBudgetState(now), toolRuntimeMs: 119_999 }, now, TEST_BUDGET).status).toBe(
      "warning",
    );
  });

  it("the default wall-time ceilings narrate from the same constants", () => {
    const desc = describeBudgetRemaining(createBudgetState(now), now, TEST_BUDGET);
    expect(desc).toContain("300s wall time");
    expect(desc).toContain("120s tool wall time");
  });

  it("selects the first exceeded ceiling before computing ratios", () => {
    const state = { ...createBudgetState(now), turns: 24, toolCalls: 40, toolRuntimeMs: 120_000 };
    expect(evaluateBudget(state, now, testBudget({ maxWallTimeMs: 0 })).exceededLimit).toBe("wall time");
    expect(evaluateBudget(state, now, testBudget({ maxWallTimeMs: -1 })).exceededLimit).toBe("turns");
    expect(evaluateBudget(state, now, testBudget({ maxWallTimeMs: -1, maxTurns: -1 })).exceededLimit).toBe(
      "tool calls",
    );
  });
});

describe("BudgetState token tracking", () => {
  it("starts with zero token counts", () => {
    const state = createBudgetState(now);
    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(0);
  });

  it("recordTokenUsage accumulates tokens", () => {
    let state = createBudgetState(now);
    state = recordTokenUsage(state, 100, 50);
    state = recordTokenUsage(state, 200, 100);
    expect(state.totalInputTokens).toBe(300);
    expect(state.totalOutputTokens).toBe(150);
  });
});
