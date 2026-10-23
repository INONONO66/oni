import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  agentBandRatchetTotal, agentBandViolations, agentIndexPerimeterViolations, validateAgentBands, validateAgentCoreLayout,
} from "../../../script/check-deps";
import { agentSourceFacts, checkCoreEndState, cloneEndStateViolations } from "../../../script/check-core-end-state";
import { coreGateFiles } from "../../../script/core-gate.test-helper";
import { CORE_END_STATE_TARGETS } from "../../../script/core-end-state-targets";
import ts from "typescript";

const roots: string[] = [];
const root = join(import.meta.dir, "../../..");
afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(overrides: Readonly<Record<string, string>> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), "core-structure-"));
  roots.push(directory);
  for (const [file, source] of Object.entries({
    ...coreGateFiles, "packages/llm/package.json": "{}", ...overrides,
  })) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), source);
  }
  return directory;
}

test("a complete structural fixture has all four historical imports accounted for", async () => {
  const directory = fixture();
  expect(await validateAgentCoreLayout(directory)).toEqual([]);
  expect(await validateAgentBands(directory)).toEqual([]);
  expect(agentBandRatchetTotal()).toBe(4);
});

test.each([
  ["api-extra.ts", ""],
  [".hidden", ""],
  ["ninth/file.ts", ""],
  ["store/third.sql", "create table third (id text);"],
  ["store/third.ts", 'const ddl = `CREATE TABLE third (id TEXT)`;'],
])("rejects extra core entry %s", async (file, source) => {
  const directory = fixture({ [`packages/agent/src/core/${file}`]: source });
  expect((await validateAgentCoreLayout(directory)).join("\n")).toContain(file.split("/")[0] ?? file);
});

test("emptying one owner and moving its DDL cannot preserve the owner count", async () => {
  const directory = fixture({
    "packages/agent/src/core/store/catalog.ts": "// CREATE TABLE is not a declaration",
    "packages/agent/src/core/store/third.ts": 'const ddl = "CREATE TABLE third (id TEXT)";',
  });
  const findings = await validateAgentCoreLayout(directory);
  expect(findings.join("\n")).toContain("core SQL schema owners");
  expect(findings.join("\n")).toContain("store/catalog.ts");
  expect(findings.join("\n")).toContain("store/third.ts");
});

test("missing owners, bands, root files and llm manifest fail closed", async () => {
  const directory = fixture();
  for (const file of ["packages/agent/src/core/api.ts", "packages/agent/src/core/gate", "packages/agent/src/core/store/catalog.ts", "packages/llm/package.json"]) {
    rmSync(join(directory, file), { recursive: true });
  }
  const findings = (await validateAgentCoreLayout(directory)).join("\n");
  for (const token of ["core root files", "core bands", "empty core band gate", "core SQL schema owners", "packages/llm/package.json"]) expect(findings).toContain(token);
});

test("moving every pinned file cannot disable migration accounting", async () => {
  const directory = fixture();
  for (const path of ["journal/compaction", "session/recovery", "session/run", "session/runtime"]) {
    const old = join(directory, `packages/agent/src/core/${path}.ts`);
    renameSync(old, old.replace(".ts", "-moved.ts"));
  }
  const findings = await validateAgentBands(directory);
  expect(findings.filter((finding) => finding.includes("inspection pin"))).toHaveLength(4);
  expect(findings.filter((finding) => finding.includes("may not import inspect/"))).toHaveLength(4);
});

test("an inspection pin cannot absorb a plugin or another inspection import", async () => {
  const directory = fixture({
    "packages/agent/src/core/session/runtime.ts": `${coreGateFiles["packages/agent/src/core/session/runtime.ts"]}\nimport { history } from "../../inspect/history";`,
    "packages/agent/src/core/session/run.ts": 'import { plugin } from "../../plugins/alarm";',
  });
  const findings = (await validateAgentBands(directory)).join("\n");
  expect(findings).toContain("may not import plugins/");
  expect(findings).toContain("may not import inspect/");
  expect(findings).toContain("session/run.ts inspection pin 1 != actual 0");
});

test("value edges fail while erased edges and quoted import text are ignored", () => {
  const path = "packages/agent/src/core/ports/types.ts";
  for (const source of ['import { x } from "../loop/turn";', 'import("../loop/turn");', 'const x = require("../loop/turn");']) {
    expect(agentBandViolations(path, source).join("\n")).toContain("core value edges");
  }
  expect(agentBandViolations(path, 'import type { T } from "../loop/turn";')).toEqual([]);
  expect(agentBandViolations(path, 'import type T = require("../loop/turn");')).toEqual([]);
  expect(agentBandViolations(path, '// import { x } from "../../plugins/alarm";\nconst text = \'import { x } from "../loop/turn"\';')).toEqual([]);
});

test("same-band cycles fail even though both individual directions are legal", async () => {
  const directory = fixture({
    "packages/agent/src/core/ports/a.ts": 'import "./b.js";',
    "packages/agent/src/core/ports/b.tsx": 'import "./a";',
  });
  expect((await validateAgentBands(directory)).join("\n")).toContain("agent value cycle");
});

test("type-only and duplicate namespace exports cannot satisfy the exact inventory", () => {
  const source = coreGateFiles["packages/agent/src/index.ts"] ?? "";
  expect(agentIndexPerimeterViolations(source.replace("export * as Core", "export type * as Core")).join("\n")).toContain("export form");
  expect(agentIndexPerimeterViolations(`${source}\nexport * as Core from "./core";`).join("\n")).toContain("export form");
});

test.each(["ModelPort", "model-port", "@oni/model", "retry-loop", "seam", "core/mailbox", "legacy-rows", "worker"])("rejects retired vocabulary %s", (token) => {
  expect(agentSourceFacts("packages/agent/src/core/ports/types.ts", `// ${token}`).retiredTokens).toBe(1);
});

test.each(["FooSeam", "seams", "ModelPortService", "seam_missing"])("rejects retired substrings in %s", (token) => {
  expect(agentSourceFacts("packages/agent/src/core/ports/probe.ts", `const ${token} = 1;`).retiredTokens).toBe(1);
});

test.each([...CORE_END_STATE_TARGETS.vocabularyExclusions.quotedIdentifiers])("only the live exclusion permits quoted %s", (token) => {
  const file = "packages/agent/src/core/ports/types.ts";
  const source = `const rejection = "${token}";`;
  expect(agentSourceFacts(file, source).retiredTokens).toBe(0);
  expect(agentSourceFacts(file, source, {
    ...CORE_END_STATE_TARGETS.vocabularyExclusions,
    quotedIdentifiers: CORE_END_STATE_TARGETS.vocabularyExclusions.quotedIdentifiers.filter((entry) => entry !== token),
  }).retiredTokens).toBe(1);
});

test.each([...CORE_END_STATE_TARGETS.vocabularyExclusions.quotedLiterals])("quoted literal pin is required for $file $token", (pin) => {
  const source = `${pin.token};\n`.repeat(pin.count);
  const rules = { ...CORE_END_STATE_TARGETS.vocabularyExclusions, quotedLiterals: [pin] };
  expect(agentSourceFacts(pin.file, source, rules).retiredTokens).toBe(0);
  expect(agentSourceFacts(pin.file, source, rules).pinViolations).toEqual([]);
  expect(agentSourceFacts(pin.file, source, { ...rules, quotedLiterals: [] }).retiredTokens).toBe(pin.count);
  expect(agentSourceFacts(pin.file, "", rules).pinViolations).toHaveLength(1);
  expect(agentSourceFacts(pin.file, `${source}${pin.token};`, rules).pinViolations).toHaveLength(1);
  expect(agentSourceFacts(`${pin.file}.moved.ts`, source, rules).retiredTokens).toBe(pin.count);
});

test("source scans distinguish imports, definitions and assertions from comments", () => {
  const file = "packages/agent/src/core/ports/types.ts";
  const facts = agentSourceFacts(file, 'import { x } from "ai"; import "node:child_process"; Bun.spawn([]); function composeAlarmPurposes() {}');
  expect(facts.forbiddenPatterns).toBe(3);
  expect(facts.coreAlarmComposers).toBe(1);
  expect(facts.pluginAlarmComposers).toBe(0);
  expect(agentSourceFacts(file, '// Bun.spawn([]); function composeAlarmPurposes() {}').forbiddenPatterns).toBe(0);
  expect(agentSourceFacts("test.ts", 'expect(fn).toThrow(); expect(fn).toThrow("typed"); // .toThrow()').emptyThrows).toBe(1);
});

test.each([
  "Bun.spawnSync([]);",
  "Bun['spawn']([]);",
  'Bun["spawnSync"]([]);',
  "const { spawn } = Bun;",
  "const { spawnSync: run } = Bun;",
  'import { spawn } from "child_process";',
  'import { spawn } from "node:child_process";',
  'import { model } from "../model.js";',
  'import { model } from "../../../model/index.js";',
  'import { model } from "./model/provider";',
])("rejects forbidden process or model form: %s", (source) => {
  expect(agentSourceFacts("packages/agent/src/core/ports/probe.ts", source).forbiddenPatterns).toBe(1);
});

function sourceFixture(overrides: Readonly<Record<string, string>> = {}): string {
  return fixture({
    "packages/agent/src/core/session/alarm-read.ts": "export function foldAlarmChains() {}",
    "packages/agent/src/plugins/alarm/index.ts": "export function composeAlarmPurposes() {}",
    "packages/agent/test/probe.test.ts": "export {};",
    ...overrides,
  });
}

function checkSourceFixture(directory: string) {
  return checkCoreEndState(directory, { ...CORE_END_STATE_TARGETS.vocabularyExclusions, quotedLiterals: [] });
}

test.each(["src", "test"])("rejects an empty %s source census", async (scope) => {
  const directory = sourceFixture();
  rmSync(join(directory, `packages/agent/${scope}`), { recursive: true });
  expect((await checkSourceFixture(directory)).join("\n")).toContain(`empty agent ${scope} census`);
});

test.each([
  ["src/core/ports/oversized.ts", 601, "longSourceFiles"],
  ["test/oversized.test.ts", 1001, "longTestFiles"],
])("rejects over-limit file %s", async (file, lines, metric) => {
  const directory = sourceFixture({ [`packages/agent/${file}`]: "\n".repeat(Number(lines)) });
  expect((await checkSourceFixture(directory)).join("\n")).toContain(`${metric} 1 != terminal 0`);
});

test.each([
  ["packages/agent/src/core/session/alarm-read.ts", "", "alarmFolds 0 != terminal 1"],
  ["packages/agent/src/core/session/duplicate.ts", "function foldAlarmChain() {}", "alarmFolds 2 != terminal 1"],
  ["packages/agent/src/plugins/alarm/index.ts", "", "alarmComposers 0 != terminal 1"],
  ["packages/agent/src/core/ports/composer.ts", "function composeAlarmPurposes() {}", "coreAlarmComposers 1 != terminal 0"],
])("rejects alarm definition drift in %s", async (file, source, diagnostic) => {
  expect((await checkSourceFixture(sourceFixture({ [file]: source }))).join("\n")).toContain(diagnostic);
});

test.each([
  ["src/core/ports/probe.ts", "const ModelPortService = 1;", "retiredTokens"],
  ["src/core/ports/probe.ts", "Bun.spawnSync([]);", "forbiddenPatterns"],
  ["test/probe.test.ts", "expect(fn).toThrow();", "emptyThrows"],
])("aggregates forbidden source or assertion evidence from %s", async (file, source, metric) => {
  const directory = sourceFixture({ [`packages/agent/${file}`]: source });
  expect((await checkSourceFixture(directory)).join("\n")).toContain(`${metric} 1 != terminal 0`);
});

test("rejects a composer moved outside its plugin despite an unchanged total", async () => {
  const directory = sourceFixture({
    "packages/agent/src/plugins/alarm/index.ts": "",
    "packages/agent/src/testing/composer.ts": "function composeAlarmPurposes() {}",
  });
  expect(await checkSourceFixture(directory)).toContain("VIOLATION: composeAlarmPurposes must have exactly one plugin/alarm owner");
});

test("accepts exact line boundaries and a complete synthetic census", async () => {
  const directory = sourceFixture({
    "packages/agent/src/core/ports/boundary.ts": "\n".repeat(600),
    "packages/agent/test/boundary.test.ts": "\n".repeat(1000),
  });
  expect(await checkSourceFixture(directory)).toEqual([]);
});

test("a missing durable literal owner leaves a stale pin", async () => {
  const directory = sourceFixture();
  const pin = { file: "packages/agent/src/core/ports/missing.ts", token: "'worker'", count: 1, owner: "fixture" };
  expect(await checkCoreEndState(directory, { quotedIdentifiers: [], quotedLiterals: [pin] }))
    .toContain(`VIOLATION: vocabulary pin owner missing: ${pin.file}`);
});

test("clone thresholds use raw counts and refuse absent census data", () => {
  const report = (clones: number, duplicatedLines: number) => JSON.stringify({ statistics: { total: { clones, duplicatedLines, lines: 1000, sources: 10 } } });
  expect(cloneEndStateViolations(report(0, 0), "production")).toEqual([]);
  expect(cloneEndStateViolations(report(1, 1), "production")).toHaveLength(1);
  expect(cloneEndStateViolations(report(1, 5), "test")).toEqual([]);
  expect(cloneEndStateViolations(report(1, 6), "test")).toHaveLength(1);
  expect(cloneEndStateViolations("{}", "test")).toHaveLength(1);
  for (const [scope, clones, lines, pin, violations] of [
    ["production", 1, 5, 1, 0],
    ["production", 0, 0, 1, 1],
    ["production", 2, 6, 1, 1],
    ["test", 1, 5, 5, 0],
    ["test", 1, 4, 5, 1],
    ["test", 1, 6, 5, 1],
  ] as const) {
    expect(cloneEndStateViolations(report(clones, lines), scope, pin)).toHaveLength(violations);
  }
});

test("real tree meets the exact structural targets", async () => {
  expect(await validateAgentCoreLayout(root)).toEqual([]);
  expect(await validateAgentBands(root)).toEqual([]);
});

test("loop gate imports are confined to the binding and shared types", () => {
  const directory = join(root, "packages/agent/src/core/loop");
  const violations = readdirSync(directory).filter((name) => name.endsWith(".ts")).flatMap((name) =>
    ts.preProcessFile(readFileSync(join(directory, name), "utf8")).importedFiles
      .filter(({ fileName }) => fileName.includes("/gate/") && !["../gate/bind", "../gate/types"].includes(fileName))
      .map(({ fileName }) => `${name}: ${fileName}`),
  );
  expect(violations).toEqual([]);
});

test("real tree meets the terminal source and test targets", async () => {
  expect(await checkCoreEndState(root)).toEqual([]);
});
