import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  agentBandRatchetTotal, agentBandViolations, agentIndexPerimeterViolations, validateAgentBands, validateAgentCoreLayout,
} from "../../../script/check-deps";
import { agentSourceFacts, checkCoreEndState, cloneEndStateViolations } from "../../../script/check-core-end-state";
import { coreGateFiles } from "../../../script/core-gate.test-helper";

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

test.each(["ModelPort", "model-port", "@openomni/model", "retry-loop", "seam", "core/mailbox", "legacy-rows", "worker"])("rejects retired vocabulary %s", (token) => {
  expect(agentSourceFacts("packages/agent/src/core/ports/types.ts", `// ${token}`).retiredTokens).toBe(1);
});

test("quoted durable identifiers and inboxId remain valid without blanket string exemptions", () => {
  const file = "packages/agent/src/core/ports/types.ts";
  expect(agentSourceFacts(file, 'const x = "seam_missing"; // `compaction_seam_missing`\nconst inboxId = "wire";').retiredTokens).toBe(0);
  expect(agentSourceFacts(file, 'const x = "new_seam_missing";').retiredTokens).toBe(1);
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

test("clone thresholds use raw counts and refuse absent census data", () => {
  const report = (clones: number, duplicatedLines: number) => JSON.stringify({ statistics: { total: { clones, duplicatedLines, lines: 1000, sources: 10 } } });
  expect(cloneEndStateViolations(report(0, 0), "production")).toEqual([]);
  expect(cloneEndStateViolations(report(1, 1), "production")).toHaveLength(1);
  expect(cloneEndStateViolations(report(1, 5), "test")).toEqual([]);
  expect(cloneEndStateViolations(report(1, 6), "test")).toHaveLength(1);
  expect(cloneEndStateViolations("{}", "test")).toHaveLength(1);
});

test("real tree meets the exact structural targets", async () => {
  expect(await validateAgentCoreLayout(root)).toEqual([]);
  expect(await validateAgentBands(root)).toEqual([]);
});

test("real tree meets the terminal source and test targets", async () => {
  expect(await checkCoreEndState(root)).toEqual([]);
});
