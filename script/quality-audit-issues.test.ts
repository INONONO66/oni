import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import ts from "typescript";
import { type Audit, type Finding, findingTotals } from "./quality-audit";
import {
  ghCommand,
  planIssues,
  previousAudit,
  publishAudit,
  regressions,
} from "./quality-audit-issues";
import { array, content, integer, inventoryFrom, loadInventory, readJson, sha, toolVersion } from "./quality-metrics/input";
import { fingerprint, readDocument, recordObject } from "./quality-ci-input";
import { mergeMeasurements, normalizeCensus } from "./quality-ci-receipt";
import { extendsChainOf, main as verifyConfigMain, verifyManifest, type Manifest } from "./verify-tsconfig-inheritance";
import { buildInventory, cliOptions, contractSchema, inventoryMain, inventorySchema } from "./quality-inventory";
import { ciMain } from "./ci";
import { main as planMain, planChanges } from "./ci-plan";
import { census, censusMain, resultSchema } from "./check-types-census";
import { TOPOLOGY } from "./topology";
import { authorityMain, authorityViolations } from "./request-authority-census";

type Issue = Parameters<typeof planIssues>[1][number];
test("authority CLI result exits nonzero for a real retired API violation", () => {
  const logs: string[] = [];
  const log = spyOn(console, "log").mockImplementation((text: string) => { logs.push(text); });
  try {
    const clean = { scanned: { production: 1, fixtures: 0, schema: 0 }, violations: [] };
    expect(authorityMain(clean)).toBe(0);
    const path = "packages/probe/src/authority.ts";
    const violations = authorityViolations(path, `export interface ${["Wait", "Store"].join("")} {}`);
    expect(violations).toContainEqual(expect.objectContaining({ rule: "legacy-api", path }));
    expect(authorityMain({ ...clean, violations })).toBe(1);
    expect(z.object({ violations: z.array(z.object({ rule: z.literal("legacy-api") })) }).parse(JSON.parse(logs[1] ?? "")).violations).toHaveLength(1);
  } finally {
    log.mockRestore();
  }
});

test("authority command scans the repository through its executable entry", () => {
  const child = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "request-authority-census.ts")],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode).toBe(0);
  const result = z.object({
    scanned: z.object({ production: z.number(), fixtures: z.number(), schema: z.number() }),
    violations: z.array(z.object({ path: z.string() })),
  }).parse(JSON.parse(child.stdout.toString()));
  expect(result.scanned.production).toBeGreaterThan(0);
  expect(result.scanned.fixtures).toBeGreaterThan(0);
  expect(result.scanned.schema).toBeGreaterThan(0);
  expect(result.violations).toEqual([]);
});

test("CI input parses documents and refuses non-object receipts", () => {
  using temp = temporaryRoot();
  const path = join(temp.root, "receipt.json");
  writeFileSync(path, '{"complete":true,"count":2}');
  expect(readDocument(path)).toEqual({ complete: true, count: 2 });
  expect(recordObject(path)).toEqual({ complete: true, count: 2 });
  writeFileSync(path, "[1,2]");
  expect(() => recordObject(path)).toThrow(/expected object/);
  writeFileSync(path, "{invalid");
  expect(() => readDocument(path)).toThrow();
});

test("CI fingerprint binds source identities in an isolated inventory", () => {
  using temp = temporaryRoot();
  mkdirSync(join(temp.root, "script"));
  writeFileSync(join(temp.root, "script/example.ts"), "export const example = 1;\n");
  writeFileSync(join(temp.root, "script/contract.json"), JSON.stringify({
    version: 1, typescript: "5.9.2", roots: ["script"], projects: ["tsconfig.json"], topology: false,
  }));
  const identity = fingerprint(temp.root, "script/contract.json");
  expect(identity.inventoryHash).toBe(sha(JSON.stringify(identity.inventory)));
  expect(identity.contractHash).toBe(identity.inventory.contractHash);
  expect(identity.paths).toEqual(["script/example.ts"]);
  expect(identity.typescript).toEqual(["script/example.ts"]);
  expect(identity.embedded).toEqual([]);
});

function withInventoryConsole(
  args: string[],
  check: (outputs: string[], errors: string[]) => void,
): void {
  const argv = [...Bun.argv];
  const outputs: string[] = [];
  const errors: string[] = [];
  const output = spyOn(console, "log").mockImplementation((text: string) => { outputs.push(text); });
  const error = spyOn(console, "error").mockImplementation((text: string) => { errors.push(text); });
  try {
    Bun.argv.splice(2, Bun.argv.length - 2, ...args);
    check(outputs, errors);
  } finally {
    Bun.argv.splice(0, Bun.argv.length, ...argv);
    output.mockRestore();
    error.mockRestore();
  }
}

test("inventory CLI checks a frozen source identity and fails closed on drift", () => {
  using temp = temporaryRoot();
  mkdirSync(join(temp.root, "script"));
  writeFileSync(join(temp.root, "script/source.ts"), "export const value = 1;\n");
  const contract = { version: 1, typescript: "5.9.2", roots: ["script"], projects: ["tsconfig.json"], topology: false };
  writeFileSync(join(temp.root, "contract.json"), JSON.stringify(contract));
  withInventoryConsole(["--root", temp.root, "--contract", "contract.json"], (outputs, errors) => {
    expect(cliOptions()).toMatchObject({ root: temp.root, contract: "contract.json" });
    expect(inventoryMain()).toBe(0);
    const frozen = inventorySchema.parse(JSON.parse(outputs[0] ?? "null"));
    expect(frozen.files.map((file) => file.path)).toEqual(["script/source.ts"]);
    writeFileSync(join(temp.root, "inventory.json"), outputs[0] ?? "");
    Bun.argv.push("--inventory", "inventory.json");
    expect(inventoryMain()).toBe(0);
    writeFileSync(join(temp.root, "script/source.ts"), "export const value = 2;\n");
    expect(inventoryMain()).toBe(2);
    expect(JSON.parse(errors[0] ?? "null")).toEqual({ code: "inventory", complete: false });
  });
});

test("inventory CLI rejects invalid options before claiming a clean receipt", () => {
  withInventoryConsole(["--not-an-option"], (_outputs, errors) => {
    expect(inventoryMain()).toBe(2);
    expect(JSON.parse(errors[0] ?? "null")).toEqual({ code: "inventory", complete: false });
  });
});

test("topology inventory binds embedded driver and tracks only Git-listed historical source", () => {
  using temp = temporaryRoot();
  writeFileSync(join(temp.root, "package.json"), JSON.stringify({ workspaces: ["packages/*", "apps/*"] }));
  writeFileSync(join(temp.root, "tsconfig.base.json"), "{}");
  for (const workspace of TOPOLOGY) {
    mkdirSync(join(temp.root, workspace.dir), { recursive: true });
    writeFileSync(join(temp.root, workspace.dir, "package.json"), JSON.stringify({ name: workspace.packageName }));
  }
  mkdirSync(join(temp.root, "script"));
  mkdirSync(join(temp.root, "docs"));
  mkdirSync(join(temp.root, "packages/codemode/src"), { recursive: true });
  const kernel = join(temp.root, "packages/codemode/src/kernel.ts");
  writeFileSync(kernel, "export const PYTHON_DRIVER = String.raw`print(1)`;\n");
  writeFileSync(join(temp.root, "docs/old.ts"), "export const legacy = 1;\n");
  const contract = contractSchema.parse({
    version: 1, typescript: "5.9.2", roots: ["apps", "packages", "script"],
    projects: ["packages/machines/tsconfig.json"], topology: true,
  });
  writeFileSync(join(temp.root, "contract.json"), JSON.stringify(contract));
  const runner: { spawnSync(args: string[]): { exitCode: number } } = Bun;
  const spawn = spyOn(runner, "spawnSync").mockImplementation((args: string[]) => {
    expect(args).toEqual(["git", "ls-files", "-z"]);
    return { exitCode: 0, stdout: Buffer.from("docs/old.ts\0docs/deleted.ts\0"), stderr: Buffer.alloc(0) };
  });
  try {
    const inventory = buildInventory(temp.root, contract);
    expect(inventory.embedded).toEqual([
      expect.objectContaining({ path: "packages/codemode/src/kernel.ts#PYTHON_DRIVER", sha256: sha("print(1)") }),
    ]);
    // docs/deleted.ts is Git-tracked but absent from the working tree: skipped.
    expect(inventory.historical.map((entry) => entry.path)).toEqual(["docs/old.ts"]);
    expect(fingerprint(temp.root, "contract.json").embedded).toEqual([
      expect.objectContaining({
        path: "packages/codemode/src/kernel.ts#PYTHON_DRIVER",
        text: "print(1)",
        lineOffset: 0,
      }),
    ]);
    writeFileSync(kernel, "export const PYTHON_DRIVER = `print(1)`;\n");
    expect(() => buildInventory(temp.root, contract)).toThrow(/unsupported embedded driver representation/);
  } finally {
    spawn.mockRestore();
  }
});

test("CI measurement rejects findings outside inventory and measured gates", () => {
  const site = { gate: "type" as const, path: "script/source.ts", line: 2, symbol: "value", value: 1 };
  expect(() => mergeMeasurements(["script/source.ts"], [{ analyzed: ["type"], findings: [{ ...site, path: "script/other.ts" }] }])).toThrow(/outside inventory/);
  expect(() => mergeMeasurements(["script/source.ts"], [{ analyzed: ["coverage"], findings: [site] }])).toThrow(/outside measured gates/);
});

test("CI census receipt carries a measured publisher finding and refuses count drift", () => {
  const identity = {
    inventoryHash: sha("inventory"), contractHash: sha("contract"),
    paths: ["script/source.ts"], typescript: ["script/source.ts"],
  };
  const receipt = {
    version: 1, complete: true, class: "publisher", analyzedClasses: ["publisher"],
    inventoryHash: identity.inventoryHash, contractHash: identity.contractHash,
    errors: [], counts: { publisher: 1 },
    findings: [{ class: "publisher", path: "script/source.ts", line: 4, symbol: "publish" }],
  };
  expect(normalizeCensus(receipt, identity, "publisher").findings).toEqual([
    { path: "script/source.ts", line: 4, symbol: "publish", gate: "publisher", value: 1 },
  ]);
  expect(() => normalizeCensus({ ...receipt, counts: { publisher: 0 } }, identity, "publisher")).toThrow(/count mismatch/);
});

test("CI dispatcher fails the build and type gates when their subprocess fails", () => {
  const runner: { spawnSync(args: string[]): { exitCode: number } } = Bun;
  const calls: string[][] = [];
  const spawn = spyOn(runner, "spawnSync").mockImplementation((args: string[]) => {
    calls.push(args);
    return { exitCode: 7 };
  });
  const previous = process.env.CI_PLAN;
  try {
    expect(() => ciMain(["build"])).toThrow("CI failed: bun run build");
    process.env.CI_PLAN = JSON.stringify(planChanges(["packages/ui/src/index.ts"]));
    expect(() => ciMain(["check-types"])).toThrow("CI failed: bunx turbo run check-types");
    expect(calls).toEqual([
      [process.execPath, "run", "build"],
      [process.execPath, "x", "turbo", "run", "check-types", "--only", "--filter=@openomni/ui", "--filter=@openomni/desktop"],
    ]);
  } finally {
    spawn.mockRestore();
    if (previous === undefined) delete process.env.CI_PLAN;
    else process.env.CI_PLAN = previous;
  }
});

test("CI test-gate checks only required jobs and rejects absent scripts contracts", () => {
  const plan = planChanges(["README.md"]);
  const previousPlan = process.env.CI_PLAN;
  const previousNeeds = process.env.CI_NEEDS;
  try {
    process.env.CI_PLAN = JSON.stringify(plan);
    process.env.CI_NEEDS = JSON.stringify({
      plan: { result: "success" }, prepare: { result: "success" },
      tests: { result: "skipped" }, "scripts-contracts": { result: "success" },
    });
    expect(ciMain(["test-gate"])).toBeUndefined();
    process.env.CI_NEEDS = JSON.stringify({
      plan: { result: "success" }, prepare: { result: "success" }, tests: { result: "skipped" },
    });
    expect(() => ciMain(["test-gate"])).toThrow("scripts-contracts: missing");
  } finally {
    if (previousPlan === undefined) delete process.env.CI_PLAN;
    else process.env.CI_PLAN = previousPlan;
    if (previousNeeds === undefined) delete process.env.CI_NEEDS;
    else process.env.CI_NEEDS = previousNeeds;
  }
});

test("CI artifact lifecycle refuses a missing build and restores a packed workspace", () => {
  using temp = temporaryRoot();
  for (const workspace of TOPOLOGY) {
    mkdirSync(join(temp.root, workspace.dir), { recursive: true });
    writeFileSync(join(temp.root, workspace.dir, "package.json"), JSON.stringify({
      scripts: workspace.key === "protocol" ? { build: "tsc" } : {},
    }));
  }
  const dist = join(temp.root, "packages/protocol/dist");
  expect(() => ciMain(["pack", "--root", temp.root])).toThrow("missing build artifact: packages/protocol/dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.js"), "export const protocol = true;\n");
  expect(ciMain(["pack", "--root", temp.root])).toBeUndefined();
  rmSync(dist, { recursive: true });
  expect(ciMain(["restore", "--root", temp.root])).toBeUndefined();
  expect(readFileSync(join(dist, "index.js"), "utf8")).toBe("export const protocol = true;\n");
});

test("CI planner accepts a real empty revision diff and writes a skip decision", () => {
  using temp = temporaryRoot();
  const root = join(import.meta.dir, "..");
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
  const output = join(temp.root, "ci-output");
  const cwd = process.cwd();
  try {
    process.chdir(root);
    planMain(["--base", sha, "--head", sha], {
      GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: output,
    });
  } finally {
    process.chdir(cwd);
  }
  expect(readFileSync(output, "utf8")).toContain("verify=false\n");
  expect(readFileSync(output, "utf8")).toContain("class=docs\n");
});

test("CI planner rejects invalid SHA before reading repository changes", () => {
  const cwd = process.cwd();
  try {
    process.chdir(join(import.meta.dir, ".."));
    expect(() => planMain(["--base", "not-a-sha", "--head", "a".repeat(40)], {
      GITHUB_EVENT_NAME: "pull_request",
    })).toThrow();
  } finally {
    process.chdir(cwd);
  }
});

test("CI planner rejects invalid workspace boundaries and undeclared dependencies", () => {
  const workspace = TOPOLOGY[0];
  expect(() => planChanges(["README.md"], false, [])).toThrow("topology must contain workspaces");
  expect(() => planChanges(["README.md"], false, [
    { ...workspace, key: "bad key" },
  ])).toThrow("invalid topology workspace boundary");
  expect(() => planChanges(["README.md"], false, [
    { ...workspace, key: "valid", allowedDeps: ["@openomni/missing"] },
  ])).toThrow("unknown topology dependency: @openomni/missing");
  expect(() => planChanges(["README.md"], false, [
    workspace, { ...workspace, key: "another", dir: "packages/other" },
  ])).toThrow("topology workspace names, keys and directories must be unique");
});

test("census ignores type-only export names and reports anonymous top types", () => {
  using temp = censusFixture();
  writeFileSync(temp.source, [
    "type Value = string;",
    "export type { Value };",
    "export { type Value as Alias };",
    "null as unknown;",
  ].join("\n"));
  const measured = census(temp.root, temp.contract, buildInventory(temp.root, temp.contract));
  expect(measured.complete).toBe(true);
  const sites = measured.violations.filter((site) => site.kind === "unknown" && site.origin === "owned");
  expect(sites.map((site) => [site.line, site.symbol])).toEqual([
    [4, "AsExpression"], [4, "UnknownKeyword"],
  ]);
});

function censusFixture() {
  const temp = temporaryRoot();
  mkdirSync(join(temp.root, "script"));
  const source = join(temp.root, "script/sample.ts");
  writeFileSync(source, "export const value = 1;\n");
  writeFileSync(join(temp.root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", types: [] },
    include: ["script/*.ts"],
  }));
  const contract = contractSchema.parse({
    version: 1, typescript: "5.9.2", roots: ["script"], projects: ["tsconfig.json"], topology: false,
  });
  return { ...temp, source, contract };
}

test("type census distinguishes a clean source from an owned unknown declaration", () => {
  using temp = censusFixture();
  const { source, contract } = temp;
  const clean = census(temp.root, contract, buildInventory(temp.root, contract));
  expect(clean.complete).toBe(true);
  expect(clean.violations).toEqual([]);
  writeFileSync(source, "export let value: unknown;\n");
  const changed = census(temp.root, contract, buildInventory(temp.root, contract));
  expect(changed.complete).toBe(true);
  expect(changed.violations.some((site) =>
    site.path === "script/sample.ts" && site.kind === "unknown" && site.origin === "owned",
  )).toBe(true);
  expect(changed.semanticMeasured).toContain("script/sample.ts");
});

test("type census CLI rejects changed inventory before measuring and reports owned debt after refreeze", () => {
  using temp = censusFixture();
  const { source, contract } = temp;
  writeFileSync(join(temp.root, "contract.json"), JSON.stringify(contract));
  const inventoryPath = join(temp.root, "inventory.json");
  const freeze = () => writeFileSync(inventoryPath, JSON.stringify(buildInventory(temp.root, contract)));
  freeze();
  withInventoryConsole(
    ["--root", temp.root, "--contract", "contract.json", "--inventory", "inventory.json"],
    (outputs) => {
      expect(censusMain()).toBe(0);
      const clean = resultSchema.parse(JSON.parse(outputs.at(-1) ?? "null"));
      expect(clean.complete).toBe(true);
      expect(clean.violations).toEqual([]);
      writeFileSync(source, "export let value: unknown;\n");
      expect(censusMain()).toBe(2);
      const drift = resultSchema.parse(JSON.parse(outputs.at(-1) ?? "null"));
      expect(drift.errors.map((row) => row.code)).toContain("inventory_drift");
      freeze();
      expect(censusMain()).toBe(1);
      const debt = resultSchema.parse(JSON.parse(outputs.at(-1) ?? "null"));
      expect(debt.complete).toBe(true);
      expect(debt.violations.some((row) => row.path === "script/sample.ts" && row.kind === "unknown" && row.origin === "owned")).toBe(true);
    },
  );
});

test("type census avoids double-counting the same project and refuses a broken project", () => {
  using temp = censusFixture();
  writeFileSync(temp.source, "export let value: unknown;\n");
  const inventory = buildInventory(temp.root, temp.contract);
  const repeated = census(temp.root, { ...temp.contract, projects: ["tsconfig.json", "tsconfig.json"] }, inventory);
  const once = census(temp.root, temp.contract, inventory);
  expect(repeated.complete).toBe(true);
  expect(repeated.violations).toEqual(once.violations);
  expect(repeated.semanticMeasured).toEqual(["script/sample.ts"]);
  const missing = census(temp.root, { ...temp.contract, projects: ["missing.json"] }, inventory);
  expect(missing.complete).toBe(false);
  expect(missing.errors.some((error) => error.code === "config" && error.path === "missing.json")).toBe(true);
});

test("type census CLI requires frozen inventory before reporting a clean result", () => {
  using temp = censusFixture();
  writeFileSync(join(temp.root, "contract.json"), JSON.stringify(temp.contract));
  withInventoryConsole(["--root", temp.root, "--contract", "contract.json"], (outputs) => {
    expect(censusMain()).toBe(2);
    const receipt = resultSchema.parse(JSON.parse(outputs.at(-1) ?? "null"));
    expect(receipt.complete).toBe(false);
    expect(receipt.errors.map((error) => error.code)).toEqual(["analyzer"]);
  });
});

function audit(findings: Finding[] = []): Audit {
  return {
    version: 1,
    head: "b".repeat(40),
    runUrl: "https://github.com/owner/repo/actions/runs/2",
    generatedAt: "2026-09-20T00:00:00.000Z",
    complete: true,
    missingLanes: [],
    tools: {
      coverage: "bun",
      complexity: "biome",
      typescriptMetrics: "typescript",
      clones: "jscpd",
      types: "census",
    },
    mutation: "see quality-mutation.yml",
    coverage: [],
    findings,
    totals: findingTotals(findings),
  };
}
function finding(path = "script/a.ts", count = 1): Finding {
  return { path, count, kind: "types", line: 2, message: "site | detail\nnext" };
}
function issue(title: string, number = 1, body = "", state: "open" | "closed" = "open"): Issue {
  return { title, number, body, state, labels: [{ name: "quality-debt" }] };
}
function summary(previous = audit()) {
  const plan = planIssues({ ...previous, head: "a".repeat(40) }, []);
  return issue("quality: audit summary", 99, plan.operation.body);
}
function fakeGh(issues: Issue[]) {
  const calls: { args: readonly string[]; input?: string }[] = [];
  const run = (args: readonly string[], input?: string) => {
    calls.push({ args, input });
    if (args[0] === "repo") return Promise.resolve(JSON.stringify({ nameWithOwner: "owner/repo" }));
    if (args.includes("--paginate"))
      return Promise.resolve(JSON.stringify([issues.slice(0, 1), issues.slice(1)]));
    return Promise.resolve(JSON.stringify({ number: 100, id: 100 }));
  };
  return { calls, run };
}

test("first run creates only the summary with round-trippable totals and no comparison", () => {
  const current = audit([finding()]);
  const plan = planIssues(current, []);
  expect(plan.firstRun).toBe(true);
  expect([plan.operation.action, plan.operation.title, plan.operation.number]).toEqual([
    "create",
    "quality: audit summary",
    undefined,
  ]);
  expect(plan.operation.body).toContain("| types | - | 1 |");
  expect(plan.operation.body).toContain("No previous audit to compare against.");
  expect(previousAudit(plan.operation.body)).toEqual({
    version: 1,
    head: current.head,
    totals: current.totals,
  });
});

test("per-file and regression issues are never created, updated, reopened or closed", () => {
  const plan = planIssues(audit([finding(), finding("script/b.ts", 3)]), [
    summary(),
    issue("quality: script/a.ts", 1),
    issue("quality: script/gone.ts", 2),
    issue("quality: script/b.ts", 3, "", "closed"),
    issue("quality: regression a..b", 4),
  ]);
  expect(plan.firstRun).toBe(false);
  expect([plan.operation.action, plan.operation.number]).toEqual(["update", 99]);
  expect(plan.operation.body).toContain("| script/b.ts | 3 |");
});

test("summary update preserves manual labels and adds quality-debt once", () => {
  const existing = summary();
  existing.labels.push({ name: "triaged" });
  const plan = planIssues(audit([finding()]), [existing]);
  expect(plan.operation.labels).toEqual(["quality-debt", "triaged"]);
});

test("closed summary is reopened rather than duplicated, open one wins over closed", () => {
  const closed = summary();
  closed.state = "closed";
  expect(planIssues(audit(), [closed]).operation).toMatchObject({ action: "update", number: 99 });
  const open = { ...summary(), number: 7 };
  expect(planIssues(audit(), [closed, open]).operation.number).toBe(7);
});

test("summary escapes a path that would break the findings table", () => {
  const body = planIssues(audit([finding("script/a|b.ts")]), []).operation.body;
  expect(body).toContain("| script/a\\|b.ts | 1 |");
});

test("regression detection is per kind, including when the total sum shrinks", () => {
  const previous = {
    version: 1 as const,
    head: "a".repeat(40),
    totals: {
      coverage: 100,
      complexity: 0,
      cyclomatic: 0,
      halstead: 0,
      crap: 0,
      clones: 0,
      types: 0,
    },
  };
  expect(regressions(previous, audit([finding()]))).toEqual([
    { kind: "types", previous: 0, current: 1 },
  ]);
  expect(regressions(previous, audit())).toEqual([]);
});

// The live persisted summary footer (issue #1119) predates the
// cyclomatic/Halstead/CRAP dimensions; its exact shape must keep decoding.
const LEGACY_FOOTER =
  '{"version":1,"head":"5b925d12bbfa154c40c84ddaed3652c999984251","totals":{"coverage":3116,"complexity":17,"clones":280,"types":2779}}';
function legacyBody() {
  return ["<!-- quality-audit:v1 -->", "```json", LEGACY_FOOTER, "```"].join("\n");
}

test("the actual version-1 footer without new dimensions still decodes", () => {
  const previous = previousAudit(legacyBody());
  expect(previous.head).toBe("5b925d12bbfa154c40c84ddaed3652c999984251");
  expect(previous.totals.coverage).toBe(3116);
  expect(previous.totals.cyclomatic).toBeUndefined();
  expect(previous.totals.halstead).toBeUndefined();
  expect(previous.totals.crap).toBeUndefined();
});

test("dimensions absent from history are not previously measured: no regression, no zeros, no reset", () => {
  const current = audit([
    { path: "script/a.ts", count: 1, kind: "cyclomatic", line: 2, message: "cyclomatic 30 >= 22" },
  ]);
  const previous = previousAudit(legacyBody());
  expect(regressions(previous, current)).toEqual([]);
  const plan = planIssues(current, [issue("quality: audit summary", 99, legacyBody())]);
  expect(plan.firstRun).toBe(false);
  expect(plan.operation.body).toContain("| cyclomatic | - | 1 |");
  expect(plan.operation.body).toContain(
    "Regressions since 5b925d12bbfa154c40c84ddaed3652c999984251: none.",
  );
  expect(previousAudit(plan.operation.body).totals.cyclomatic).toBe(1);
});

test("a version-1 dimension regression renders inside the summary, never as its own issue", () => {
  const current = audit([finding("script/a.ts", 2780)]);
  const plan = planIssues(current, [issue("quality: audit summary", 99, legacyBody())]);
  expect(plan.operation.title).toBe("quality: audit summary");
  expect(plan.operation.body).toContain("| types | 2779 | 2780 |");
  expect(plan.operation.body).toContain(
    "Regressions since 5b925d12bbfa154c40c84ddaed3652c999984251: types 2779 -> 2780.",
  );
});

test("history corruption is an error, not a new first run", () => {
  expect(() => previousAudit("no block")).toThrow();
  expect(() => previousAudit("<!-- quality-audit:v1 -->\n```json\n{}\n```")).toThrow();
  expect(() => planIssues(audit(), [issue("quality: audit summary")])).toThrow();
});

test("summary bounds the findings table to fifty files and stays under the issue body limit", () => {
  const current = audit(
    Array.from({ length: 60 }, (_: undefined, index) => finding(`script/${index}.ts`, index + 1)),
  );
  const body = planIssues(current, []).operation.body;
  expect(body).toContain(current.runUrl);
  expect(body.split("\n").filter((line) => line.startsWith("| script/"))).toHaveLength(50);
  expect(body.length).toBeLessThan(65_536);
});

test("fake gh first run creates one label and only one issue via JSON", async () => {
  const fake = fakeGh([]);
  const result = await publishAudit(audit([finding()]), fake.run, "owner/repo");
  expect(result.firstRun).toBe(true);
  expect(fake.calls.filter((call) => call.args[0] === "label").map((call) => call.args[2])).toEqual(
    ["quality-debt"],
  );
  expect(fake.calls.filter((call) => call.input)).toHaveLength(1);
  const body = z
    .object({ title: z.string(), body: z.string() })
    .parse(JSON.parse(fake.calls.at(-1)?.input ?? "null"));
  expect(body.title).toBe("quality: audit summary");
  expect(previousAudit(body.body).totals.types).toBe(1);
});

test("fake gh pagination finds the closed summary on page two and reopens it as the only write", async () => {
  const closed = summary();
  closed.state = "closed";
  const fake = fakeGh([issue("quality: gone.ts", 1), closed, issue("quality: script/a.ts", 2)]);
  await publishAudit(audit([finding()]), fake.run, "owner/repo");
  const writes = fake.calls.filter((call) => call.input);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.args).toContain("repos/owner/repo/issues/99");
  expect(z.object({ state: z.string() }).parse(JSON.parse(writes[0]?.input ?? "null")).state).toBe(
    "open",
  );
});

test("fake gh failures and incomplete evidence never advance summary history", async () => {
  const fake = fakeGh([]);
  await expect(
    publishAudit({ ...audit(), complete: false }, fake.run, "owner/repo"),
  ).rejects.toThrow();
  expect(fake.calls).toHaveLength(0);
  await expect(publishAudit(audit(), () => Promise.resolve("{}"), "owner/repo")).rejects.toThrow();
  const calls: string[] = [];
  await expect(
    publishAudit(
      audit(),
      (args) => {
        calls.push(args[0] ?? "");
        if (args[0] === "label") return Promise.reject(new Error("denied"));
        return Promise.resolve("[[]]");
      },
      "owner/repo",
    ),
  ).rejects.toThrow("denied");
  expect(calls).toEqual(["api", "label"]);
});

test("repository lookup uses parsed gh JSON when not supplied", async () => {
  const fake = fakeGh([]);
  await publishAudit(audit(), fake.run, "");
  expect(fake.calls[0]?.args).toEqual(["repo", "view", "--json", "nameWithOwner"]);
  await expect(publishAudit(audit(), fake.run, "bad/repo/path")).rejects.toThrow();
});

test("gh process boundary sends JSON stdin and surfaces nonzero exits", async () => {
  const text = await ghCommand(
    ["-e", "process.stdout.write(JSON.stringify({input: await Bun.stdin.text(), cwd: process.cwd()}))"],
    '{"number":12}',
    process.execPath,
  );
  expect(z.object({ input: z.string(), cwd: z.string() }).parse(JSON.parse(text))).toEqual({
    input: '{"number":12}',
    cwd: process.cwd(),
  });
  expect(await ghCommand(["-e", "process.stdout.write('{}')"], undefined, process.execPath)).toBe(
    "{}",
  );
  await expect(
    ghCommand(["-e", "console.error('denied');process.exit(3)"], undefined, process.execPath),
  ).rejects.toThrow("exited 3");
});

// The sweep's only editable test file also covers the metrics and tsconfig
// boundaries; their existing test files belong to other lanes.
function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "quality-script-boundary-"));
  return { root, [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }) };
}

test("metric inventory resolves and authenticates real, historical, and embedded sources", () => {
  using temp = temporaryRoot();
  mkdirSync(join(temp.root, "src"));
  const host = 'const DRIVER = String.raw`print("ok")`;\n';
  writeFileSync(join(temp.root, "src/host.ts"), host);
  writeFileSync(join(temp.root, "src/old.ts"), "export const old = 1;\n");
  writeFileSync(join(temp.root, "tsconfig.json"), "{}");
  const entry = (path: string, text: string, language = "typescript") => ({
    path, sha256: sha(text), bytes: Buffer.byteLength(text), category: "production", language,
  });
  const input = {
    version: 1,
    contractHash: sha("contract"),
    files: [entry("src/host.ts", host)],
    historical: [entry("src/old.ts", "export const old = 1;\n")],
    configurations: [{ path: "tsconfig.json", sha256: sha("{}") }],
    embedded: [entry("src/host.ts#DRIVER", 'print("ok")', "python")],
  };
  const bytes = Buffer.from(JSON.stringify(input));
  const result = inventoryFrom(temp.root, bytes, "inventory.json");
  expect(result.inventoryHash).toBe(sha(bytes));
  expect(result.files[0]?.text).toBe(host);
  expect(result.historical[0]?.path).toBe("src/old.ts");
  expect(result.embedded[0]).toMatchObject({
    path: "src/host.ts#DRIVER", text: 'print("ok")', hostPath: "src/host.ts",
  });
  expect(result.embedded[0]?.hostOffset).toBe(host.indexOf('`') + 1);
  expect(result.configurations).toEqual(input.configurations);
});

test("metric inventory rejects mutated source and configuration bytes", () => {
  using temp = temporaryRoot();
  writeFileSync(join(temp.root, "source.ts"), "export const value = 1;\n");
  writeFileSync(join(temp.root, "tsconfig.json"), "{}");
  const source = "export const value = 1;\n";
  const input = {
    version: 1, contractHash: sha("contract"),
    files: [{ path: "source.ts", sha256: sha(source), bytes: Buffer.byteLength(source), category: "production", language: "typescript" }],
    historical: [], embedded: [],
    configurations: [{ path: "tsconfig.json", sha256: sha("{}") }],
  };
  const load = () => inventoryFrom(temp.root, Buffer.from(JSON.stringify(input)), "inventory.json");
  expect(load().files[0]?.text).toBe(source);
  writeFileSync(join(temp.root, "inventory.json"), JSON.stringify(input));
  expect(loadInventory(temp.root, join(temp.root, "inventory.json")).files[0]?.text).toBe(source);
  writeFileSync(join(temp.root, "source.ts"), "export const value = 2;\n");
  expect(load).toThrow(/source identity differs/);
  writeFileSync(join(temp.root, "source.ts"), source);
  writeFileSync(join(temp.root, "tsconfig.json"), '{"changed":true}');
  expect(load).toThrow(/configuration differs/);
});

test("metric inventory rejects invalid virtual source identity and overlapping paths", () => {
  using temp = temporaryRoot();
  const source = "const DRIVER = String.raw`print(1)`;\n";
  writeFileSync(join(temp.root, "host.ts"), source);
  const file = { path: "host.ts", sha256: sha(source), bytes: Buffer.byteLength(source), category: "production", language: "typescript" };
  const virtual = { path: "host.ts#DRIVER", sha256: sha("print(1)"), bytes: 8, category: "production", language: "python" };
  const input = { version: 1, contractHash: sha("contract"), files: [file], historical: [], configurations: [], embedded: [virtual] };
  const load = () => inventoryFrom(temp.root, Buffer.from(JSON.stringify(input)), "inventory.json");
  expect(load().embedded[0]?.text).toBe("print(1)");
  expect(() => inventoryFrom(temp.root, Buffer.from(JSON.stringify({ ...input, version: 2 })), "inventory.json")).toThrow(/unsupported inventory version/);
  expect(() => inventoryFrom(temp.root, Buffer.from(JSON.stringify({ ...input, files: [] })), "inventory.json")).toThrow(/virtual source host absent/);
  expect(() => inventoryFrom(temp.root, Buffer.from(JSON.stringify({ ...input, embedded: [{ ...virtual, sha256: sha("wrong") }] })), "inventory.json")).toThrow(/virtual source identity differs/);
  expect(() => inventoryFrom(temp.root, Buffer.from(JSON.stringify({ ...input, embedded: [virtual, virtual] })), "inventory.json")).toThrow(/overlapping inventory/);
  expect(() => inventoryFrom(temp.root, Buffer.from(JSON.stringify({ ...input, embedded: [{ ...virtual, path: "host.ts#OTHER" }] })), "inventory.json")).toThrow(/resolve uniquely/);
});

test("metric input refuses malformed primitives and malformed source entries", () => {
  expect(integer(0)).toBe(0);
  for (const value of [-1, 0.5, "1", null]) expect(() => integer(value)).toThrow(/nonnegative integer/);
  expect(array([1, "two"])).toEqual([1, "two"]);
  expect(() => array({ length: 0 })).toThrow(/expected array/);
  using temp = temporaryRoot();
  const input = { version: 1, contractHash: sha("contract"), files: [{ path: "../escape" }], historical: [], configurations: [], embedded: [] };
  expect(() => inventoryFrom(temp.root, Buffer.from(JSON.stringify(input)), "inventory.json")).toThrow(/invalid source entry/);
  writeFileSync(join(temp.root, "input.json"), '{"measured":true}');
  expect(readJson(join(temp.root, "input.json"))).toEqual({ measured: true });
  writeFileSync(join(temp.root, "input.json"), "{invalid");
  expect(() => readJson(join(temp.root, "input.json"))).toThrow(/malformed JSON/);
});

test("metric inventory rejects bytes that match a hash but cannot round-trip as UTF-8", () => {
  using temp = temporaryRoot();
  const bytes = Buffer.from([0xff]);
  writeFileSync(join(temp.root, "source.ts"), bytes);
  const input = {
    version: 1, contractHash: sha("contract"),
    files: [{ path: "source.ts", sha256: sha(bytes), bytes: bytes.length, category: "production", language: "typescript" }],
    historical: [], configurations: [], embedded: [],
  };
  expect(() => inventoryFrom(temp.root, Buffer.from(JSON.stringify(input)), "inventory.json")).toThrow(/source must be UTF-8/);
});

test("metric input confines source paths and pins actual analyzer package versions", () => {
  using temp = temporaryRoot();
  writeFileSync(join(temp.root, "source.ts"), "owned");
  expect(content(temp.root, "source.ts").toString()).toBe("owned");
  expect(() => content(temp.root, "../outside.ts")).toThrow();
  const compiler = z.object({ version: z.string() }).parse(readJson(require.resolve("typescript/package.json")));
  expect(toolVersion("typescript", compiler.version)).toMatchObject({ name: "typescript", version: compiler.version, invocation: "runtime API" });
  expect(() => toolVersion("typescript", "0.0.0")).toThrow(/expected 0.0.0/);
});

function configFixture() {
  const temp = temporaryRoot();
  mkdirSync(join(temp.root, "src"));
  writeFileSync(join(temp.root, "src/one.ts"), "export const one = 1;\n");
  writeFileSync(join(temp.root, "tsconfig.base.json"), "{}");
  writeFileSync(join(temp.root, "tsconfig.json"), JSON.stringify({
    extends: "./tsconfig.base",
    compilerOptions: { declaration: true, rootDir: "src", outDir: "dist" },
    include: ["src/*.ts"],
  }));
  const manifest: Manifest = {
    root: temp.root, base: "tsconfig.base.json", projects: ["tsconfig.json"],
    sourceRoots: ["src"], declarationProject: "tsconfig.json",
    emitPolicy: { "tsconfig.json": { declaration: true, noEmit: false, forbidComposite: true, forbidProjectReferences: true } },
  };
  return { ...temp, manifest };
}

test("tsconfig verifier resolves extensionless inheritance and emitted declarations", () => {
  using fixture = configFixture();
  expect(extendsChainOf(join(fixture.root, "tsconfig.json"), "tsconfig.json")).toEqual({
    chain: [join(fixture.root, "tsconfig.base.json")], problem: null,
  });
  expect(verifyManifest(fixture.manifest)).toMatchObject({ ok: true, claimedFileCount: 1 });
  mkdirSync(join(fixture.root, "dist"));
  writeFileSync(join(fixture.root, "dist/one.d.ts"), "export declare const one = 1;\n");
  expect(verifyManifest(fixture.manifest).problems).toEqual([]);
});

test("tsconfig verifier rejects missing and unexpected built declarations", () => {
  using fixture = configFixture();
  mkdirSync(join(fixture.root, "dist"));
  expect(verifyManifest(fixture.manifest).problems.map((row) => row.code)).toEqual(["declaration_output_drift"]);
  writeFileSync(join(fixture.root, "dist/one.d.ts"), "export declare const one = 1;\n");
  writeFileSync(join(fixture.root, "dist/extra.d.ts"), "export {};\n");
  const problems = verifyManifest(fixture.manifest).problems;
  expect(problems.map((row) => row.code)).toEqual(["declaration_output_drift"]);
  expect(problems[0]?.message).toContain("unexpected declaration");
});

test("tsconfig declaration project rejects an input that derives no declaration", () => {
  using fixture = configFixture();
  writeFileSync(join(fixture.root, "tsconfig.json"), JSON.stringify({
    extends: "./tsconfig.base",
    compilerOptions: { rootDir: "src", outDir: "dist" },
    include: ["src/*.ts"],
  }));
  const result = verifyManifest({ ...fixture.manifest, emitPolicy: undefined });
  expect(result.problems.map((row) => row.code)).toEqual(["declaration_output_drift"]);
  expect(result.problems[0]?.message).toContain("derives no .d.ts output");
});

test("tsconfig verifier rejects missing projects, unsupported references and cycles", () => {
  using fixture = configFixture();
  expect(verifyManifest({ ...fixture.manifest, projects: ["missing.json"] }).code).toBe("config_parse_error");
  writeFileSync(join(fixture.root, "tsconfig.json"), '{"extends":"typescript/base"}');
  expect(verifyManifest(fixture.manifest).code).toBe("config_parse_error");
  writeFileSync(join(fixture.root, "tsconfig.json"), '{"extends":"./missing"}');
  expect(verifyManifest(fixture.manifest).code).toBe("missing_base_config");
  writeFileSync(join(fixture.root, "tsconfig.json"), '{"extends":"./tsconfig.base"}');
  writeFileSync(join(fixture.root, "tsconfig.base.json"), '{"extends":"./tsconfig"}');
  expect(verifyManifest(fixture.manifest).problems[0]?.message).toContain("circular extends chain");
});

test("tsconfig verifier rejects malformed config and chains that omit the declared base", () => {
  using fixture = configFixture();
  writeFileSync(join(fixture.root, "tsconfig.json"), "{broken");
  expect(verifyManifest(fixture.manifest).code).toBe("config_parse_error");
  writeFileSync(join(fixture.root, "tsconfig.json"), '{"compilerOptions":{"declaration":true},"include":["src/*.ts"]}');
  expect(verifyManifest(fixture.manifest).code).toBe("not_extending_base");
  writeFileSync(join(fixture.root, "tsconfig.json"), '{"extends":"./tsconfig.base","compilerOptions":{"target":"not-a-target"},"include":["src/*.ts"]}');
  expect(verifyManifest(fixture.manifest).code).toBe("config_parse_error");
});

test("tsconfig verifier rejects a project with invalid options after resolving its base", () => {
  using fixture = configFixture();
  writeFileSync(join(fixture.root, "tsconfig.json"), JSON.stringify({
    extends: "./tsconfig.base",
    compilerOptions: { target: "not-a-target" },
    include: ["src/*.ts"],
  }));
  const result = verifyManifest(fixture.manifest);
  expect(result.code).toBe("config_parse_error");
  expect(result.problems[0]?.message).toContain("Argument for '--target' option");
});

test("tsconfig verifier fails closed when a config disappears after its extends scan", () => {
  using fixture = configFixture();
  const configPath = join(fixture.root, "tsconfig.json");
  const read = ts.sys.readFile;
  let removed = false;
  const hook = spyOn(ts.sys, "readFile").mockImplementation((path, encoding) => {
    const text = read(path, encoding);
    if (path === configPath && !removed && text !== undefined) {
      removed = true;
      rmSync(configPath);
    }
    return text;
  });
  try {
    const result = verifyManifest(fixture.manifest);
    expect(removed).toBe(true);
    expect(result.code).toBe("config_parse_error");
    expect(result.problems[0]?.message).toContain("config did not parse");
  } finally {
    hook.mockRestore();
  }
});


test("tsconfig verifier detects unclaimed roots and drift in composite or references", () => {
  using fixture = configFixture();
  expect(verifyManifest({ ...fixture.manifest, sourceRoots: ["absent"] }).code).toBe("missing_source_root");
  writeFileSync(join(fixture.root, "src/two.ts"), "export const two = 2;\n");
  writeFileSync(join(fixture.root, "tsconfig.json"), JSON.stringify({
    extends: "./tsconfig.base", compilerOptions: { declaration: true, composite: true },
    files: ["src/one.ts"], references: [{ path: "./tsconfig.base.json" }],
  }));
  const result = verifyManifest(fixture.manifest);
  expect(result.problems.map((row) => row.code)).toContain("omitted_input");
  expect(result.problems.filter((row) => row.code === "emit_policy_drift").map((row) => row.message)).toEqual([
    expect.stringContaining("composite resolved"),
    expect.stringContaining("project reference"),
  ]);
});

test("tsconfig verifier CLI preserves human and JSON success and failure exits", () => {
  const argv = [...process.argv];
  const output: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, "log").mockImplementation((text: string) => { output.push(text); });
  const error = spyOn(console, "error").mockImplementation((text: string) => { errors.push(text); });
  const exit = spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit ${code}`); });
  const fixture = (name: string) => join(import.meta.dir, "fixtures/tsconfig-inheritance", `${name}.json`);
  try {
    process.argv.splice(2, process.argv.length - 2, "--fixture", fixture("valid"));
    expect(() => verifyConfigMain()).toThrow("exit 0");
    expect(output.at(-1)).toContain("OK: tsconfig inheritance");
    process.argv.splice(2, process.argv.length - 2, "--fixture", fixture("missing-base"));
    expect(() => verifyConfigMain()).toThrow("exit 1");
    expect(errors.some((line) => line.includes("missing_base_config"))).toBe(true);
    process.argv.splice(2, process.argv.length - 2, "--fixture", fixture("valid"), "--json");
    expect(() => verifyConfigMain()).toThrow("exit 0");
    expect(JSON.parse(output.at(-1) ?? "null")).toMatchObject({ ok: true, code: null });
    process.argv.splice(2, process.argv.length - 2, "--fixture");
    expect(() => verifyConfigMain()).toThrow("exit 2");
    expect(errors.at(-1)).toBe("--fixture requires a manifest path");
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    exit.mockRestore();
    log.mockRestore();
    error.mockRestore();
  }
});

test("tsconfig CLI reports successful and failed fixture checks through real exit codes", () => {
  const verifier = join(import.meta.dir, "verify-tsconfig-inheritance.ts");
  const fixtures = join(import.meta.dir, "fixtures/tsconfig-inheritance");
  const run = (fixture: string, json: boolean) => Bun.spawnSync([
    process.execPath, verifier, "--fixture", join(fixtures, `${fixture}.json`), ...(json ? ["--json"] : []),
  ], { stdout: "pipe", stderr: "pipe" });
  const valid = run("valid", false);
  expect(valid.exitCode).toBe(0);
  expect(valid.stdout.toString()).toContain("OK: tsconfig inheritance");
  const missing = run("missing-base", false);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr.toString()).toContain("missing_base_config");
  const machine = run("valid", true);
  expect(machine.exitCode).toBe(0);
  expect(JSON.parse(machine.stdout.toString())).toMatchObject({ ok: true, code: null });
  const invalid = Bun.spawnSync([process.execPath, verifier, "--fixture"], { stdout: "pipe", stderr: "pipe" });
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stderr.toString()).toContain("--fixture requires a manifest path");
});
