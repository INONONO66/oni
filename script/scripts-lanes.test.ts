import { expect, test } from "bun:test";
import { pythonSelfTests, pythonTests, scriptPartitions, scriptTestCommand, scriptTests, scriptToolingPartitions, scriptsLanes } from "./scripts-lanes";

test("every recursive script test belongs to exactly one explicit lane", () => {
  const root = import.meta.dir;
  const actual = [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: root })].sort();
  const assigned = Object.values(scriptsLanes).flat().sort();
  expect(actual).toEqual(assigned);
  expect(new Set(assigned).size).toBe(assigned.length);
  expect(() => scriptTests("scripts-contracts", [...actual, "unclassified.test.ts"])).toThrow("unclassified.test.ts");
  expect(scriptTests("scripts-tooling", actual)).toEqual(scriptsLanes["scripts-tooling"]);
  const partitioned = Object.values(scriptToolingPartitions).flat();
  expect(new Set(partitioned).size).toBe(partitioned.length);
  expect([...partitioned].sort()).toEqual([...scriptsLanes["scripts-tooling"]].sort());
  expect(Object.keys(scriptToolingPartitions)).toEqual(scriptPartitions.filter((key) => key !== "scripts-contracts"));
});

test("every Python self-test belongs to the explicit manifest the first tooling shard measures", () => {
  const actual = [...new Bun.Glob("**/{test_*,*.test}.py").scanSync({ cwd: import.meta.dir })].sort();
  expect(actual).toEqual([...pythonSelfTests].sort());
  expect(pythonTests(actual)).toEqual(pythonSelfTests);
  expect(() => pythonTests([...actual, "quality-mutation/test_python_new.py"])).toThrow("quality-mutation/test_python_new.py");
  expect(() => pythonTests(actual.slice(1))).toThrow(actual[0] ?? "");
});

test("compiler contracts run separately from mutation campaigns", () => {
  expect(scriptToolingPartitions["scripts-tooling-2"]).toContain("run-quality-mutations-compiler.test.ts");
  expect(scriptToolingPartitions["scripts-tooling-1"]).toContain("run-quality-mutations.test.ts");
  expect(scriptsLanes["scripts-contracts"]).toContain("check-benchmark-regression.test.ts");
});

test("shard commands execute each assigned test exactly once without hash sharding", () => {
  const selected = scriptPartitions.flatMap((partition) => {
    const command = scriptTestCommand(partition);
    expect(command.some((arg) => arg.startsWith("--shard"))).toBe(false);
    return command.filter((arg) => arg.endsWith(".test.ts")).map((arg) => arg.slice(2));
  });
  const partitionOwned = [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: import.meta.dir })].filter(
    (path) => !scriptsLanes["clients-conformance"].some((entry) => entry === path),
  );
  expect(selected.sort()).toEqual(partitionOwned.sort());
  expect(scriptTests("clients-conformance")).toEqual(["check-clients-conformance.test.ts"]);
  expect(() => scriptTestCommand("scripts-tooling-3")).toThrow("invalid script partition");
});
