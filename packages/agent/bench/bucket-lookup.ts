import { KERNEL_POLICY_REGISTRY } from "../src/core/gate/compile";
import { expect, test } from "bun:test";
import { compilePolicySnapshot, type PolicyEvaluationInput } from "../src/core/gate/compile";
import { atGeneration, compaction, draft, MemoryPolicyRows, unrelatedRows, } from "../test/kernel/gate/row-fixtures";

const ROW_COUNT = 220;
const EVALUATION_COUNT = 100_000;
const BATCH_SIZE = 1_000;
const MAX_P50_MICROSECONDS = 20;

const input: PolicyEvaluationInput = {
  kind: "tool",
  phase: "pre",
  op: "read",
  role: "resident",
  sessionId: "benchmark-session",
  value: { path: "/workspace/readme.md" },
};

test("bucket lookup stays below the policy hot-path budget", () => {
  const unrelated = unrelatedRows(ROW_COUNT - 2);
  const source = new MemoryPolicyRows([
    atGeneration(compaction, 1),
    atGeneration(
      draft("allow-read", "tool", "pre", { type: "allow" }, { match: { op: "read" } }),
      1,
    ),
    ...unrelated,
  ]);
  const evaluator = compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY, rows: source.rows(1), generation: 1 });

  for (let index = 0; index < 10_000; index += 1) evaluator.evaluate(input);
  const readsBefore = source.reads;
  const samples: number[] = [];
  for (let batch = 0; batch < EVALUATION_COUNT / BATCH_SIZE; batch += 1) {
    const startedAt = performance.now();
    for (let index = 0; index < BATCH_SIZE; index += 1) evaluator.evaluate(input);
    samples.push(((performance.now() - startedAt) * 1_000) / BATCH_SIZE);
  }
  samples.sort((left, right) => left - right);
  const p50Microseconds = samples[Math.floor(samples.length / 2)];

  if (p50Microseconds === undefined) throw new Error("benchmark produced no samples");
  console.info(
    `policy bucket benchmark: rows=${ROW_COUNT} evaluations=${EVALUATION_COUNT} p50=${p50Microseconds.toFixed(3)}us storageReads=${source.reads - readsBefore}`,
  );

  expect(source.reads).toBe(readsBefore);
  expect(p50Microseconds).toBeLessThan(MAX_P50_MICROSECONDS);
}, 30_000);
