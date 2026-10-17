import { testExecutor } from "../../helpers/executor";
import { KERNEL_POLICY_REGISTRY } from "../../../src/core/gate/compile";
import type { LedgerAction } from "@openomni/protocol";
import { isolated } from "../../helpers/isolated";
import { expect, test } from "bun:test";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "../../../src/core/gate/compile";
import { stopState, type StopObservation } from "../../../src/core/loop/turn";
import { recordingLedger } from "../../helpers/g0-effect";

function harness(limit = 3) {
  const record = recordingLedger();
  const policy = compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY,
    generation: 1,
    rows: SEEDED_POLICY_ROWS.map((row: (typeof SEEDED_POLICY_ROWS)[number]) => ({
      ...row,
      generation: 1,
      verdict: {
        ...row.verdict,
        value:
          typeof row.verdict.value === "object" &&
          row.verdict.value !== null &&
          !Array.isArray(row.verdict.value) &&
          row.verdict.value.type === "obligation"
            ? { ...row.verdict.value, limit: row.verdict.value.metric === "continuation" ? 8 : limit }
            : row.verdict.value,
      },
    })),
  });
  return {
    ...record,
    executor: testExecutor({
      policy,
      ledger: record.ledger,
      identity: { sessionId: "session", role: "resident", parentActionId: "turn" },
      clock: () => 1,
      entropy: record.entropy,
      random: () => 0,
      observations: { publish: () => undefined },
    }),
  };
}
const ordinary: StopObservation = {
  text: "done",
  toolCalls: 0,
  interrupted: false,
  exhausted: false,
  progress: false,
  blocked: false,
  openIntent: [],
  alarmIds: [],
};

test("executor stop judgment consumes pinned policy and records the first verdict", async () => {
  for (const [observation, expected] of [
    [{ ...ordinary, interrupted: true, exhausted: true }, "interrupted"],
    [{ ...ordinary, exhausted: true }, "error"],
    [ordinary, "result"],
    [{ ...ordinary, toolCalls: 1 }, "continue"],
    [{ ...ordinary, openIntent: ["unanswered-message"] }, "continue"],
    [{ ...ordinary, openIntent: ["unconsumed-approval"] }, "continue"],
    [{ ...ordinary, text: "", alarmIds: ["armed-this-turn"] }, "waiting"],
    [{ ...ordinary, text: "" }, "continue"],
  ] as const) {
    const { executor, committed } = harness();
    const result = await isolated(executor.judgeStop(stopState(), observation));
    expect(result.verdict.kind).toBe(expected);
    expect(committed.filter((a: LedgerAction.Append) => a.kind === "turn")).toHaveLength(1);
  }
});

test("alternate policy thresholds change repetition; invoking tools never resets progress", async () => {
  for (const limit of [2, 4]) {
    const { executor } = harness(limit);
    let state = stopState();
    for (let step = 1; step <= limit; step += 1) {
      const result = await isolated(executor.judgeStop(state, { ...ordinary, toolCalls: 1 }));
      expect(result.verdict).toMatchObject(
        step === limit ? { kind: "error", reason: "exact_repeat" } : { kind: "continue" },
      );
      state = result.state;
    }
  }
});

test("three distinct tool inputs continue but three identical calls stop", async () => {
  for (const distinct of [true, false]) {
    const { executor } = harness();
    let state = stopState();
    for (let step = 1; step <= 3; step += 1) {
      const result = await isolated(executor.judgeStop(state, {
        ...ordinary,
        text: "",
        toolCalls: 1,
        calls: [{ tool: "read", input: { path: distinct ? `file-${step}` : "same" } }],
      }));
      expect(result.verdict).toMatchObject(
        !distinct && step === 3
          ? { kind: "error", reason: "exact_repeat" }
          : { kind: "continue" },
      );
      state = result.state;
    }
    console.log(`A7 repeat distinct=${distinct} steps=3 repetition=${state.repetition}`);
  }
});

test("changed outputs without tools stall, denied tools recur, committed effects reset streaks", async () => {
  for (const blocked of [false, true]) {
    const { executor } = harness();
    let state = stopState();
    for (let i = 1; i <= 3; i += 1) {
      const result = await isolated(
        executor.judgeStop(state, {
          ...ordinary,
          text: String(i),
          openIntent: ["pending"],
          toolCalls: blocked ? 1 : 0,
          blocked,
        }),
      );
      if (i === 3)
        expect(result.verdict).toMatchObject({
          kind: "error",
          reason: blocked ? "blocked_recurrence" : "toolless_stall",
        });
      state = result.state;
    }
    const reset = await isolated(
      executor.judgeStop(state, { ...ordinary, toolCalls: 1, progress: true }),
    );
    expect(reset.state).toMatchObject({ repetition: 0, stall: 0, blocked: 0 });
  }
});
