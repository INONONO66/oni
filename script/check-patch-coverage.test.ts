import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedLines,
  checkPatchCoverage,
  gatedPath,
  hasExecutableCode,
  lcovPrefix,
  lcovUnion,
  main,
  uncoveredRows,
} from "./check-patch-coverage";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

test("gatedPath admits product src and tooling, refuses tests and docs", () => {
  expect(gatedPath("packages/agent/src/executor.ts")).toBe(true);
  expect(gatedPath("packages/ui/src/tree-row.tsx")).toBe(true);
  expect(gatedPath("packages/ui/src/styles.css")).toBe(false);
  expect(gatedPath("apps/oni/src/cli/daemon.ts")).toBe(true);
  expect(gatedPath("script/check-deps.ts")).toBe(true);
  expect(gatedPath("script/check-deps.test.ts")).toBe(false);
  expect(gatedPath("packages/agent/src/executor.test.ts")).toBe(false);
  expect(gatedPath("packages/agent/test/helper.ts")).toBe(false);
  // #1318: nested script trees are production tooling and ARE gated ...
  expect(gatedPath("script/quality-metrics/input.ts")).toBe(true);
  expect(gatedPath("script/quality-metrics/input.test.ts")).toBe(false);
  expect(gatedPath("script/quality-mutation/tool.ts")).toBe(true);
  // ... while fixture trees stay test inputs, never tooling.
  expect(gatedPath("script/fixtures/x/src/a.ts")).toBe(false);
  expect(gatedPath("script/fixtures/tsconfig-inheritance/valid/src/entry.ts")).toBe(false);
  expect(gatedPath("docs/ci.md")).toBe(false);
});

test("#1318 planted escape: an uncovered line in a nested script path fails the gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "patch-cov-nested-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "qa@example.com");
    git(dir, "config", "user.name", "qa");
    git(dir, "commit", "--allow-empty", "-qm", "base");
    const base = git(dir, "rev-parse", "HEAD");
    mkdirSync(join(dir, "script/quality-metrics"), { recursive: true });
    writeFileSync(
      join(dir, "script/quality-metrics/input.ts"),
      "export const covered = 1;\nexport const planted = 2;\n",
    );
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "nested tooling");
    mkdirSync(join(dir, "script/coverage"), { recursive: true });
    writeFileSync(
      join(dir, "script/coverage/lcov.info"),
      "SF:quality-metrics/input.ts\nDA:1,1\nDA:2,0\nend_of_record\n",
    );
    const glob = ["--glob", "script/coverage/lcov.info"];
    expect(checkPatchCoverage(base, ["script/coverage/lcov.info"], dir)).toEqual([
      "script/quality-metrics/input.ts:2",
    ]);
    expect(main(["--base", base, ...glob], dir)).toBe(1);
    // A fixture-tree change under script/fixtures/ is NOT gated.
    mkdirSync(join(dir, "script/fixtures/case/src"), { recursive: true });
    writeFileSync(join(dir, "script/fixtures/case/src/a.ts"), "export const fixture = 3;\n");
    writeFileSync(
      join(dir, "script/coverage/lcov.info"),
      "SF:quality-metrics/input.ts\nDA:1,1\nDA:2,1\nend_of_record\n",
    );
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "fixture tree");
    expect(main(["--base", base, ...glob], dir)).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lcovPrefix maps artifact layouts to repo prefixes", () => {
  expect(lcovPrefix("cov/coverage-agent/packages/agent/coverage/lcov.info")).toBe("packages/agent");
  expect(lcovPrefix("cov/coverage-x/apps/oni/coverage/lcov.info")).toBe("apps/oni");
  expect(lcovPrefix("cov/coverage-scripts-tooling-1/script/coverage/lcov.info")).toBe("script");
  expect(lcovPrefix("packages/agent/coverage/lcov.info")).toBe("packages/agent");
});

test("changedLines keeps only gated files with unified-0 hunks", () => {
  const diff = [
    "diff --git a/packages/agent/src/a.ts b/packages/agent/src/a.ts",
    "--- a/packages/agent/src/a.ts",
    "+++ b/packages/agent/src/a.ts",
    "@@ -1,2 +10,3 @@",
    "@@ -9 +20 @@",
    "--- a/docs/ci.md",
    "+++ b/docs/ci.md",
    "@@ -1 +1,5 @@",
  ].join("\n");
  const changed = changedLines(diff);
  expect([...changed.keys()]).toEqual(["packages/agent/src/a.ts"]);
  expect([...(changed.get("packages/agent/src/a.ts") ?? [])]).toEqual([10, 11, 12, 20]);
});

test("uncovered rows: zero-hit lines fail, unknown lines are not executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "patch-cov-lcov-"));
  try {
    mkdirSync(join(dir, "packages/agent/coverage"), { recursive: true });
    mkdirSync(join(dir, "script/coverage"), { recursive: true });
    writeFileSync(
      join(dir, "packages/agent/coverage/lcov.info"),
      "SF:src/a.ts\nDA:10,0\nDA:11,3\nend_of_record\n",
    );
    writeFileSync(
      join(dir, "script/coverage/lcov.info"),
      "SF:check-thing.ts\nDA:5,0\nend_of_record\n",
    );
    const union = lcovUnion(
      [join(dir, "packages/agent/coverage/lcov.info"), join(dir, "script/coverage/lcov.info")],
      dir,
    );
    const changed = new Map([
      ["packages/agent/src/a.ts", new Set([10, 11, 12])],
      ["script/check-thing.ts", new Set([5])],
      ["packages/agent/src/type-only.ts", new Set([1])],
      ["packages/agent/src/untested.ts", new Set([1])],
    ]);
    const executable = (path: string) => !path.includes("type-only");
    expect(uncoveredRows(changed, union, executable)).toEqual([
      "packages/agent/src/a.ts:10",
      "packages/agent/src/untested.ts: no coverage record",
      "script/check-thing.ts:5",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lcov union takes the maximum hits across shards", () => {
  const dir = mkdtempSync(join(tmpdir(), "patch-cov-union-"));
  try {
    mkdirSync(join(dir, "a/script/coverage"), { recursive: true });
    mkdirSync(join(dir, "b/script/coverage"), { recursive: true });
    writeFileSync(join(dir, "a/script/coverage/lcov.info"), "SF:x.ts\nDA:1,0\nDA:2,2\n");
    writeFileSync(join(dir, "b/script/coverage/lcov.info"), "SF:x.ts\nDA:1,7\nDA:2,0\n");
    const union = lcovUnion(
      [join(dir, "a/script/coverage/lcov.info"), join(dir, "b/script/coverage/lcov.info")],
      dir,
    );
    expect(union.get("script/x.ts")?.get(1)).toBe(7);
    expect(union.get("script/x.ts")?.get(2)).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lcov union merges a cross-workspace relative SF path with the owner lane", () => {
  // apps/oni's lane records the agent module it loaded as
  // `SF:../../packages/agent/src/x.ts`; that record must merge with the
  // agent lane's `SF:src/x.ts`, not survive as a separate unnormalized key.
  const dir = mkdtempSync(join(tmpdir(), "patch-cov-cross-"));
  try {
    mkdirSync(join(dir, "packages/agent/coverage"), { recursive: true });
    mkdirSync(join(dir, "apps/oni/coverage"), { recursive: true });
    writeFileSync(join(dir, "packages/agent/coverage/lcov.info"), "SF:src/x.ts\nDA:1,0\nDA:2,4\n");
    writeFileSync(join(dir, "apps/oni/coverage/lcov.info"), "SF:../../packages/agent/src/x.ts\nDA:1,9\nDA:2,0\n");
    const union = lcovUnion(
      [join(dir, "packages/agent/coverage/lcov.info"), join(dir, "apps/oni/coverage/lcov.info")],
      dir,
    );
    expect([...union.keys()]).toEqual(["packages/agent/src/x.ts"]);
    expect(union.get("packages/agent/src/x.ts")?.get(1)).toBe(9);
    expect(union.get("packages/agent/src/x.ts")?.get(2)).toBe(4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lcov union drops a line only an unexecuted lane reports as zero", () => {
  // Bun emits DA:n,0 for every line of a never-run function (braces, comments);
  // the lane that ran it reports only executable lines. Line 3 exists solely
  // in the unexecuted lane and must not surface as an uncovered claim.
  const dir = mkdtempSync(join(tmpdir(), "patch-cov-lanes-"));
  try {
    mkdirSync(join(dir, "a/script/coverage"), { recursive: true });
    mkdirSync(join(dir, "b/script/coverage"), { recursive: true });
    writeFileSync(join(dir, "a/script/coverage/lcov.info"), "SF:x.ts\nDA:1,0\nDA:2,0\nDA:3,0\nDA:4,0\n");
    writeFileSync(join(dir, "b/script/coverage/lcov.info"), "SF:x.ts\nDA:1,5\nDA:2,0\nDA:4,3\n");
    const union = lcovUnion(
      [join(dir, "a/script/coverage/lcov.info"), join(dir, "b/script/coverage/lcov.info")],
      dir,
    );
    const rows = union.get("script/x.ts");
    expect(rows?.get(1)).toBe(5);
    expect(rows?.get(2)).toBe(0);
    expect(rows?.has(3)).toBe(false);
    expect(rows?.get(4)).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lcov union refuses a flattened artifact whose workspace root is lost", () => {
  // upload-artifact with a single `path:` drops the `script/coverage/` ancestor;
  // every SF would then be attributed to the repo root and read as "no record".
  const dir = mkdtempSync(join(tmpdir(), "patch-cov-flat-"));
  try {
    mkdirSync(join(dir, "coverage-scripts-contracts"), { recursive: true });
    const flat = join(dir, "coverage-scripts-contracts/lcov.info");
    writeFileSync(flat, "SF:ci.ts\nDA:1,1\n");
    expect(() => lcovUnion([flat], dir)).toThrow(/without workspace ancestor/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end to end against a fixture repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "patch-cov-repo-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "qa@example.com");
    git(dir, "config", "user.name", "qa");
    mkdirSync(join(dir, "packages/kit/src"), { recursive: true });
    writeFileSync(join(dir, "packages/kit/src/sum.ts"), "export const sum = 1;\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "base");
    const base = git(dir, "rev-parse", "HEAD");
    writeFileSync(
      join(dir, "packages/kit/src/sum.ts"),
      "export const sum = 1;\nexport const covered = 2;\nexport const uncovered = 3;\nexport type OnlyType = number;\n",
    );
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "change");
    mkdirSync(join(dir, "packages/kit/coverage"), { recursive: true });
    writeFileSync(
      join(dir, "packages/kit/coverage/lcov.info"),
      "SF:src/sum.ts\nDA:1,1\nDA:2,1\nDA:3,0\nend_of_record\n",
    );
    const rows = checkPatchCoverage(base, ["packages/*/coverage/lcov.info"], dir);
    expect(rows).toEqual(["packages/kit/src/sum.ts:3"]);
    // A brand-new file no test ever loads has no SF record and must fail;
    // a type-only module emits no code and is exempt.
    writeFileSync(join(dir, "packages/kit/src/orphan.ts"), "export const orphan = () => 4;\n");
    writeFileSync(join(dir, "packages/kit/src/shape.ts"), "export type Shape = { x: number };\n");
    git(dir, "add", "packages/kit/src");
    git(dir, "commit", "-qm", "orphan");
    expect(checkPatchCoverage(base, ["packages/*/coverage/lcov.info"], dir)).toEqual([
      "packages/kit/src/orphan.ts: no coverage record",
      "packages/kit/src/sum.ts:3",
    ]);
    git(dir, "reset", "-q", "--hard", "HEAD~1");
    const glob = ["--glob", "packages/*/coverage/lcov.info"];
    expect(main(["--base", base, ...glob], dir)).toBe(1);
    writeFileSync(
      join(dir, "packages/kit/coverage/lcov.info"),
      "SF:src/sum.ts\nDA:1,1\nDA:2,1\nDA:3,1\nend_of_record\n",
    );
    expect(main(["--base", base, ...glob], dir)).toBe(0);
    expect(() => main([], dir)).toThrow("usage:");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

type SyntaxFixture = { name: string; source: string; uncovered: number[] };

const syntaxFixtures: SyntaxFixture[] = [
  {
    name: "zero-hit import header before a TaggedError class",
    source: 'import { \n  Data, \n } from "effect";\nimport type { Effect } from "effect";\nexport class Failure extends Data.TaggedError("Failure") {}\n',
    uncovered: [5],
  },
  {
    name: "type aliases, interfaces, type members and re-exports",
    source: 'export type Name = string;\nexport interface Port {\n  readonly name: Name;\n  run(): void;\n}\nexport { value } from "./value";\nexport type { Other } from "./other";\nabstract class Base {\n  declare name: string;\n  abstract run(): void;\n  value = 1;\n}\n',
    uncovered: [8, 11],
  },
  {
    name: "generator and argument-list closing delimiters",
    source: 'export function* values() {\n  yield consume(\n    [1\n    ]\n  );\n}\n',
    uncovered: [1, 2, 3],
  },
  {
    name: "real statements mixed with exempt declarations or closing braces",
    source: 'import type { Name } from "./name"; execute();\nexport type Count = number; execute();\nfunction run() {\n  execute();\n} run();\nexport const value = 1;\n',
    uncovered: [1, 2, 3, 4, 5, 6],
  },
  {
    name: "child-only entry points remain executable",
    source: 'if (import.meta.main) {\n  try {\n    await acquire();\n  } finally {\n    await dispose();\n  }\n}\n',
    uncovered: [1, 2, 3, 4, 5],
  },
  {
    name: "runtime heritage, fields, dynamic imports and export assignments",
    source: 'export class Derived extends\n  makeBase()\n{\n  field: string;\n  value = compute();\n}\nexport default\n  compute();\nconst loaded = import(\n  "./module"\n);\n',
    uncovered: [1, 2, 3, 4, 5, 7, 8, 9, 10],
  },
  {
    name: "empty statements and loop separators stay gated",
    source: ';\nfor (\n;\n;\n) {}\n',
    uncovered: [1, 2, 3, 4, 5],
  },
  {
    name: "comments and blank lines around executable statements",
    source: '/** documentation */\n\n// comment\nexecute(); // runtime\n',
    uncovered: [4],
  },
  {
    name: "template and JSX text are not closing tokens or comments",
    source: 'export const text = `\n}\n;\n`;\nexport const view = <div>\n)\n</div>;\n',
    uncovered: [1, 2, 3, 4, 5, 6, 7],
  },
];

test.each(syntaxFixtures)("AST filtering: $name", (fixture: SyntaxFixture) => {
  const dir = mkdtempSync(join(tmpdir(), "patch-cov-syntax-"));
  const path = "packages/kit/src/fixture.tsx";
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "qa@example.com");
    git(dir, "config", "user.name", "qa");
    git(dir, "commit", "--allow-empty", "-qm", "base");
    const base = git(dir, "rev-parse", "HEAD");
    mkdirSync(join(dir, "packages/kit/src"), { recursive: true });
    writeFileSync(join(dir, path), fixture.source);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "fixture");
    mkdirSync(join(dir, "packages/kit/coverage"), { recursive: true });
    const records = fixture.source.trimEnd().split("\n").map(
      (_line: string, index: number) => `DA:${index + 1},0`,
    );
    writeFileSync(join(dir, "packages/kit/coverage/lcov.info"), `SF:src/fixture.tsx\n${records.join("\n")}\nend_of_record\n`);
    const skipped = new Map<string, number>();
    expect(checkPatchCoverage(base, ["packages/*/coverage/lcov.info"], dir, skipped)).toEqual(
      fixture.uncovered.map((line: number) => `${path}:${line}`),
    );
    expect(skipped.get(path)).toBe(records.length - fixture.uncovered.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasExecutableCode strips types and keeps code", () => {
  expect(
    hasExecutableCode("export type A = number;\nexport interface B { x: string }\n", "a.ts"),
  ).toBe(false);
  expect(hasExecutableCode("// comments only\n", "a.ts")).toBe(false);
  expect(hasExecutableCode("export type A = 1;\nexport const b = 2;\n", "a.ts")).toBe(true);
  expect(hasExecutableCode("export const Chip = () => <div />;\n", "chip.tsx")).toBe(true);
});
