import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlainValueSchema } from "../packages/protocol/src/json.js";
import { knipWorkspaces } from "./topology";
import {
  censusConsumerFindings,
  compareDeadExports,
  main,
  normalizeKnipIssues,
  readBaseline,
  runKnip,
  runProductionKnip,
  selfTest,
} from "./check-dead-exports";

const ROOT = join(import.meta.dir, "..");
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })));
});

test("member issues normalize to stable Parent.name keys and duplicates flatten", () => {
  expect(
    normalizeKnipIssues({
      issues: [
        {
          file: "packages/fixture/src/index.ts",
          enumMembers: { Mode: [{ name: "LEGACY", line: 12, col: 3 }] },
          namespaceMembers: { Api: [{ name: "orphan", line: 20, col: 3 }] },
          duplicates: [[{ name: "twin" }, { name: "twin" }]],
        },
        { file: "packages/fixture/src/orphan.ts", files: [{ name: "orphan.ts" }] },
      ],
    }),
  ).toEqual([
    "duplicates packages/fixture/src/index.ts twin",
    "enumMembers packages/fixture/src/index.ts Mode.LEGACY",
    "files packages/fixture/src/orphan.ts",
    "namespaceMembers packages/fixture/src/index.ts Api.orphan",
  ]);
});

test("normalizer ignores empty issue groups and keeps primitive issue names", () => {
  expect(normalizeKnipIssues({
    issues: [{
      file: "unused.ts",
      exports: ["plain", { name: "named" }, ["nested"]],
      enumMembers: { Empty: [], Mode: ["LEGACY"] },
      namespaceMembers: { Empty: null },
      dependencies: null,
    }],
  })).toEqual([
    "enumMembers unused.ts Mode.LEGACY",
    "exports unused.ts named",
    "exports unused.ts nested",
    "exports unused.ts plain",
  ]);
});

test("comparison reports only added and resolved keys", () => {
  expect(compareDeadExports(["kept", "removed"], ["kept", "added"])).toEqual({
    newIssues: ["added"],
    resolved: ["removed"],
  });
});

test("runKnip refuses a knip.json whose workspaces drift from the topology", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "oni-knip-inventory-"));
  fixtures.push(fixture);
  await writeFile(join(fixture, "knip.json"), `${JSON.stringify({ workspaces: { bogus: {} } })}\n`);
  const cwd = process.cwd();
  process.chdir(fixture);
  try {
    await expect(runKnip(".")).rejects.toThrow("knip workspace topology drift");
  } finally {
    process.chdir(cwd);
  }
});

test.each([
  ["process failure", { exitCode: 7, stdout: "", stderr: "knip unavailable" }, "knip exited with code 7: knip unavailable"],
  ["malformed JSON", { exitCode: 0, stdout: "not json", stderr: "" }, "knip did not emit parseable JSON: not json"],
])("runKnip rejects %s from its command transport", async (_name, result, message) => {
  await expect(runKnip(".", false, false, async () => result)).rejects.toThrow(message);
});

test.each([
  ["unchanged", ["exports unused.ts orphan"], [{ file: "unused.ts", exports: ["orphan"] }], 0, "none new"],
  ["resolved", ["exports unused.ts orphan"], [], 0, "baseline entry is no longer reported"],
  ["new issue", [], [{ file: "unused.ts", exports: ["orphan"] }], 1, "VIOLATION [dead-exports]"],
])("in-process ratchet recognizes %s", async (_name, baseline, issues, code, text) => {
  const fixture = await mkdtemp(join(tmpdir(), "oni-knip-main-"));
  fixtures.push(fixture);
  await mkdir(join(fixture, "script/conformance"), { recursive: true });
  await writeFile(join(fixture, "script/conformance/knip-baseline.json"), JSON.stringify({ grandfathered: baseline }));
  const cwd = process.cwd();
  const argv = process.argv;
  process.argv = [process.execPath, join(import.meta.dir, "check-dead-exports.ts")];
  process.chdir(fixture);
  const output: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: string) => {
    output.push(chunk);
    return true;
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string) => {
    output.push(chunk);
    return true;
  });
  try {
    expect(await main(async () => [{ issues }, { issues: [] }])).toBe(code);
    expect(output.join("")).toContain(text);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    process.chdir(cwd);
    process.argv = argv;
  }
});

test("production knip refuses an executable with the wrong version", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "oni-knip-version-"));
  fixtures.push(fixture);
  const executable = join(fixture, "knip.ts");
  await writeFile(executable, 'process.stdout.write("knip 0.0.0\\n");');
  expect(runProductionKnip({ root: fixture, executable, config: "knip.json" })).toEqual({
    ok: false,
    code: "tool_version",
    message: "census requires knip 6.31.0",
  });
});

test("production knip preserves successful reports and failed process stderr", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "oni-knip-transport-"));
  fixtures.push(fixture);
  const executable = join(fixture, "knip.ts");
  await writeFile(executable, `
if (process.argv.includes("--version")) process.stdout.write("6.31.0\\n");
else if (process.argv.includes("--cache")) process.stderr.write("catalog failed");
else process.stdout.write('{"issues":[]}');
if (process.argv.includes("--cache")) process.exitCode = 1;
`);
  expect(runProductionKnip({ root: fixture, executable, config: "knip.json" })).toEqual({
    ok: true, stdout: '{"issues":[]}',
  });
  expect(runProductionKnip({ root: fixture, executable, config: "knip.json", cache: true })).toEqual({
    ok: false, code: "knip_failure", message: "catalog failed",
  });
});

test("dead-export self-test discriminates additions from baseline shrinkage", () => {
  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "check-dead-exports.ts"), "--self-test"],
    { cwd: ROOT, timeout: 15_000 },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("new issues discriminate");
});

test("in-process self-test verifies normalization and ratchet decisions", async () => {
  const argv = process.argv;
  const lines: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: string) => {
    lines.push(chunk);
    return true;
  });
  process.argv = [process.execPath, join(import.meta.dir, "check-dead-exports.ts"), "--self-test"];
  try {
    expect(await main()).toBe(0);
    expect(lines.join("")).toContain("new issues discriminate");
  } finally {
    process.argv = argv;
    stdout.mockRestore();
  }
});

test("in-process update writes normalized baseline keys to the configured fixture", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "oni-knip-update-"));
  fixtures.push(fixture);
  await mkdir(join(fixture, "script/conformance"), { recursive: true });
  const cwd = process.cwd();
  const argv = process.argv;
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  process.argv = [process.execPath, join(import.meta.dir, "check-dead-exports.ts"), "--update"];
  process.chdir(fixture);
  try {
    expect(await main(async () => [
      { issues: [{ file: "unused.ts", exports: ["orphan"] }] },
      { issues: [] },
    ])).toBe(0);
    const written = PlainValueSchema.parse(JSON.parse(
      readFileSync(join(fixture, "script/conformance/knip-baseline.json"), "utf8"),
    ));
    expect(written).toEqual({ grandfathered: ["exports unused.ts orphan"] });
  } finally {
    process.chdir(cwd);
    process.argv = argv;
    stdout.mockRestore();
  }
});

test("entry-export census admits only topology package barrels", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "oni-knip-entry-"));
  fixtures.push(fixture);
  await mkdir(join(fixture, "script/conformance"), { recursive: true });
  await writeFile(join(fixture, "script/conformance/knip-baseline.json"), '{"grandfathered":[]}');
  const cwd = process.cwd();
  const argv = process.argv;
  const violations: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string) => {
    violations.push(chunk);
    return true;
  });
  process.argv = [process.execPath, join(import.meta.dir, "check-dead-exports.ts")];
  process.chdir(fixture);
  try {
    expect(await main(async () => [
      { issues: [] },
      { issues: [
        { file: "packages/protocol/src/index.ts", exports: ["publicDead"] },
        { file: "packages/protocol/src/internal.ts", exports: ["privateDead"] },
      ] },
    ])).toBe(1);
    expect(violations.join("")).toContain("exports packages/protocol/src/index.ts publicDead");
    expect(violations.join("")).not.toContain("privateDead");
  } finally {
    process.chdir(cwd);
    process.argv = argv;
    stderr.mockRestore();
  }
});

test.each([
  ["unchanged baseline", ["exports unused.ts orphan"], [{ file: "unused.ts", exports: ["orphan"] }], 0, "none new"],
  ["resolved baseline", ["exports unused.ts orphan"], [], 0, "baseline entry is no longer reported"],
  ["new issue", [], [{ file: "unused.ts", exports: ["orphan"] }], 1, "VIOLATION [dead-exports]"],
])("CLI reports %s from the knip JSON transport", async (_name, baseline, issues, code, text) => {
  const fixture = await mkdtemp(join(tmpdir(), "oni-knip-cli-"));
  fixtures.push(fixture);
  await mkdir(join(fixture, "bin"), { recursive: true });
  await mkdir(join(fixture, "script/conformance"), { recursive: true });
  await writeFile(join(fixture, "knip.json"), JSON.stringify({
    workspaces: Object.fromEntries([".", ...knipWorkspaces().map((workspace) => workspace.dir)].map((dir) => [dir, {}])),
  }));
  await writeFile(join(fixture, "script/conformance/knip-baseline.json"), JSON.stringify({ grandfathered: baseline }));
  const executable = join(fixture, "bin/bunx");
  await writeFile(executable, "#!/bin/sh\nprintf '%s\\n' \"$KNIP_REPORT\"\n");
  chmodSync(executable, 0o700);
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "check-dead-exports.ts")], {
    cwd: fixture,
    env: { ...process.env, PATH: `${join(fixture, "bin")}:${process.env.PATH}`, KNIP_REPORT: JSON.stringify({ issues }) },
    timeout: 15_000,
  });
  expect(result.exitCode).toBe(code);
  expect(`${result.stdout}${result.stderr}`).toContain(text);
});

test("census projection keeps only exports without a production consumer", () => {
  const consumed = {
    class: "export" as const,
    definition: { path: "packages/agent/src/used.ts", line: 4, symbol: "used" },
    consumers: [{ role: "production" as const }],
  };
  const testOnly = {
    class: "export" as const,
    definition: { path: "packages/agent/src/idle.ts", line: 9, symbol: "idle" },
    consumers: [{ role: "test" as const }, { role: "barrel" as const }],
  };
  expect(censusConsumerFindings([consumed, testOnly])).toEqual([
    {
      path: "packages/agent/src/idle.ts",
      line: 9,
      symbol: "idle",
      class: "export",
      message: "export has no production consumer; tests and barrels do not count",
    },
  ]);
});

test("census rejects aliases that refer to different definitions", () => {
  const rows = [
    {
      class: "publisher" as const,
      definition: { path: "first.ts", line: 1, symbol: "first" },
      aliases: ["shared"],
      consumers: [{ role: "publish" as const }],
    },
    {
      class: "publisher" as const,
      definition: { path: "second.ts", line: 2, symbol: "second" },
      aliases: ["shared"],
      consumers: [{ role: "publish" as const }],
    },
  ];
  expect(() => censusConsumerFindings(rows)).toThrow("CENSUS_ALIAS_COLLISION shared");
});

test("census requires publisher, store, and export consumers in their own roles", () => {
  const definition = { path: "shared.ts", line: 1, symbol: "value" };
  const classes = ["publisher", "store", "export"] as const;
  expect(
    censusConsumerFindings(
      classes.map((kind) => ({
        class: kind,
        definition,
        consumers: [{ role: "test" as const }],
      })),
    ).map(({ class: kind, message }) => ({ kind, message })),
  ).toEqual([
    { kind: "publisher", message: "event has no production publisher" },
    { kind: "store", message: "store is registered but never read in production" },
    { kind: "export", message: "export has no production consumer; tests and barrels do not count" },
  ]);
});

test("census accepts only a matching consumer role for each class", () => {
  const definition = { path: "shared.ts", line: 1, symbol: "value" };
  expect(censusConsumerFindings([
    { class: "publisher", definition, consumers: [{ role: "publish" }] },
    { class: "store", definition, consumers: [{ role: "read" }] },
    { class: "export", definition, consumers: [{}] },
    { class: "publisher", definition, consumers: [{}] },
    { class: "store", definition, consumers: [{ role: "production" }] },
  ])).toEqual([
    { ...definition, class: "publisher", message: "event has no production publisher" },
    { ...definition, class: "store", message: "store is registered but never read in production" },
  ]);
});

test("the shipped baseline parses and compares clean against itself", () => {
  const cwd = process.cwd();
  process.chdir(ROOT);
  try {
    const baseline = readBaseline();
    const onDisk = PlainValueSchema.parse(JSON.parse(
      readFileSync(join(ROOT, "script/conformance/knip-baseline.json"), "utf8"),
    ));
    expect(onDisk).toEqual({ grandfathered: [...baseline.grandfathered] });
    expect(compareDeadExports(baseline.grandfathered, baseline.grandfathered)).toEqual({
      newIssues: [],
      resolved: [],
    });
  } finally {
    process.chdir(cwd);
  }
});

test("self-test rejects broken knip report checks", () => {
  const errors: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  let comparisons = 0;
  try {
    expect(selfTest(
      () => [],
      () => {
        comparisons += 1;
        return comparisons === 1
          ? { newIssues: [], resolved: [] }
          : { newIssues: ["unexpected"], resolved: [] };
      },
    )).toBe(1);
    expect(comparisons).toBe(3);
    expect(errors).toEqual([
      "SELF-TEST FAIL: normalizer produced unexpected keys: \n",
      "SELF-TEST FAIL: a new dead export beyond the baseline was not flagged\n",
      "SELF-TEST FAIL: an unchanged report was flagged\n",
      "SELF-TEST FAIL: a resolved baseline entry failed the check (shrink must be --update-only)\n",
    ]);
  } finally {
    stderr.mockRestore();
  }
});
