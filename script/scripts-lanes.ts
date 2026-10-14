import { join } from "node:path";

/** Explicit, recursive inventory. New tests require an ownership decision. */
export const scriptsLanes = {
  "scripts-contracts": [
    "benchmark-workflow.test.ts",
    "check-benchmark-regression.test.ts",
    "check-core-end-state.test.ts",
    "check-dead-exports.test.ts",
    "check-import-cycles.test.ts",
    "check-journal-writers.test.ts",
    "check-patch-coverage.test.ts",
    "check-topology.test.ts",
    "ci-plan.test.ts",
    "ci.test.ts",
    "conformance/lint-side-effects.test.ts",
    "conformance/protocol-event-pairing.test.ts",
    "conformance/request-authority-census.test.ts",
    "gate-discovery.test.ts",
    "lint-guards.test.ts",
    "lint-side-effects.test.ts",
    "lint-tools.test.ts",
    "main-runner.test.ts",
    "scripts-lanes.test.ts",
    "tool-target-deletion.test.ts",
    "verify-tsconfig-inheritance.test.ts",
    "check-effect-boundaries.test.ts",
    "effect-error-contract.test.ts",
    "effect-service-contract.test.ts",
  ],
  "scripts-tooling": [
    "bundle-type-contract.test.ts",
    "census-consumer-contract.test.ts",
    "check-comment-residue.test.ts",
    "check-deps.test.ts",
    "check-deps-agent-bands.test.ts",
    "check-quality-python.test.ts",
    "check-types-census.test.ts",
    "check-written-types.test.ts",
    "conformance/summarize-benchmark-runs.test.ts",
    "generate-models-snapshot.test.ts",
    "quality-audit.test.ts",
    "quality-audit-issues.test.ts",
    "quality-ci-receipt.test.ts",
    "quality-inventory.test.ts",
    "quality-json.test.ts",
    "quality-mutation-reach-overlay.test.ts",
    "quality-mutation-shard.test.ts",
    "quality-mutation-workflow.test.ts",
    "quality-native-mutation.test.ts",
    "quality-native-process.test.ts",
    "quality-plan.test.ts",
    "quality-source.test.ts",
    "run-quality-mutations.test.ts",
    "run-quality-mutations-compiler.test.ts",
    "run-quality-mutations-operators.test.ts",
  ],
} as const;
export type ScriptsLane = keyof typeof scriptsLanes;
export const scriptPartitions = [
  "scripts-contracts",
  "scripts-tooling-1",
  "scripts-tooling-2",
] as const;
// #1116 lean PR gate: the ratchet-only tooling suites are gone; the surviving
// mutation-runner suites split by their measured heavy hitters
// (run-quality-mutations ~197s uninstrumented, the full-repository compiler
// suites, check-types-census ~48s) so both shards stay far below the timeout.
export const scriptToolingPartitions = {
  "scripts-tooling-1": [
    "census-consumer-contract.test.ts",
    "check-deps.test.ts",
    "check-deps-agent-bands.test.ts",
    "check-written-types.test.ts",
    "run-quality-mutations.test.ts",
    "quality-mutation-workflow.test.ts",
    "quality-source.test.ts",
    "run-quality-mutations-operators.test.ts",
    "quality-native-mutation.test.ts",
    "quality-json.test.ts",
    "quality-audit.test.ts",
    "quality-audit-issues.test.ts",
    "quality-native-process.test.ts",
  ],
  "scripts-tooling-2": [
    "bundle-type-contract.test.ts",
    "check-comment-residue.test.ts",
    "generate-models-snapshot.test.ts",
    "run-quality-mutations-compiler.test.ts",
    "quality-mutation-shard.test.ts",
    "check-types-census.test.ts",
    "quality-mutation-reach-overlay.test.ts",
    "quality-ci-receipt.test.ts",
    "quality-inventory.test.ts",
    "quality-plan.test.ts",
    "check-quality-python.test.ts",
    "conformance/summarize-benchmark-runs.test.ts",
  ],
} as const;
export type ScriptToolingPartition = keyof typeof scriptToolingPartitions;
export const scriptContracts = [
  ["check-dead-exports.ts", "--self-test"],
  ["check-deps.ts", "--self-test"],
  ["check-import-cycles.ts", "--self-test"],
  ["check-effect-boundaries.ts"],
] as const;
/** Python analyzer self-tests: explicit inventory, run by the first tooling shard. */
export const pythonSelfTests = ["quality-mutation/python-engine.test.py"] as const;
export function pythonTests(
  actual = [...new Bun.Glob("**/{test_*,*.test}.py").scanSync({ cwd: import.meta.dir })],
): readonly string[] {
  const missing = actual.filter((path) => !pythonSelfTests.some((entry) => entry === path));
  const absent = pythonSelfTests.filter((path) => !actual.includes(path));
  if (missing.length || absent.length)
    throw new Error(`python self-test drift: ${[...missing, ...absent].join(", ")}`);
  return pythonSelfTests;
}
export function scriptTests(
  lane: ScriptsLane,
  actual = [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: import.meta.dir })],
): readonly string[] {
  const assigned = Object.values(scriptsLanes).flat();
  const missing = actual.filter((path) => !assigned.some((entry) => entry === path));
  const absent = assigned.filter((path) => !actual.includes(path));
  if (missing.length || absent.length || new Set(assigned).size !== assigned.length) {
    throw new Error(`script test lane drift: ${[...missing, ...absent].join(", ")}`);
  }
  return scriptsLanes[lane];
}
export function scriptTestCommand(partition: string) {
  if (!scriptPartitions.some((key) => key === partition))
    throw new Error(`invalid script partition: ${partition}`);
  const tooling = partition !== "scripts-contracts";
  const lane = scriptTests(tooling ? "scripts-tooling" : "scripts-contracts");
  const tests = tooling ? scriptToolingPartitions[partition as ScriptToolingPartition] : lane;
  return [
    "bun",
    "test",
    ...tests.map((path) => `./${path}`),
    "--timeout",
    "15000",
    "--coverage",
    "--coverage-reporter=lcov",
    "--coverage-dir=coverage",
    ...(tooling ? [`--timings=${join("coverage", "timings.json")}`, "--update-timings"] : []),
  ];
}
