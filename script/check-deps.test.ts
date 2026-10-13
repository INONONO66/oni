import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  agentBandViolations,
  agentIndexPerimeterViolations,
  appsRetiredHostViolations,
  checkBundleImports,
  checkDocFreshness,
  main,
  validateAgentBands,
  validateAgentIndexPerimeter,
  validateAppsAgentBarrel,
} from "./check-deps";
import { checkPython } from "./check-quality-python";
import { TOPOLOGY } from "./topology";

const roots: string[] = [];
const checker = join(import.meta.dir, "check-deps.ts");
const audit = "apps/openomni/src/bundles/audit-log/index.ts";
const demo = "apps/openomni/src/bundles/demo/index.ts";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Readonly<Record<string, string>>, directory = tmpdir()): string {
  const root = mkdtempSync(join(directory, "bundle-imports-"));
  roots.push(root);
  const manifests = Object.fromEntries(
    TOPOLOGY.map((workspace) => [
      `${workspace.dir}/package.json`,
      JSON.stringify({ name: workspace.packageName }),
    ]),
  );
  for (const [path, source] of Object.entries({ ...manifests, ...files })) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return root;
}

async function runInProcess(root: string) {
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const output: string[] = [];
  const error: string[] = [];
  const logged = spyOn(console, "log").mockImplementation((message: string) =>
    output.push(message),
  );
  const warned = spyOn(console, "warn").mockImplementation((message: string) =>
    error.push(message),
  );
  const failed = spyOn(console, "error").mockImplementation((message: string) =>
    error.push(message),
  );
  try {
    process.chdir(root);
    await main();
    return { code: process.exitCode, output: output.join("\n"), error: error.join("\n") };
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode ?? 0;
    logged.mockRestore();
    warned.mockRestore();
    failed.mockRestore();
  }
}

async function run(root: string) {
  const inProcess = await runInProcess(root);
  const result = Bun.spawnSync([process.execPath, checker], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  const error = result.stderr.toString();
  expect(inProcess.code).toBe(result.exitCode);
  expect(result.stdout.toString().trimEnd()).toBe(inProcess.output);
  expect(error.trimEnd()).toBe(inProcess.error);
  return { code: result.exitCode, error };
}

test.each([
  'import { value } from "../demo/index.js";',
  'import type { Value } from "../demo/index.js";',
  'import "../demo/index.js";',
  'export { value as renamed } from "../demo/index.js";',
  'export type { Value } from "../demo/index.js";',
  'export * from "../demo/index.js";',
  'export * as Demo from "../demo/index.js";',
  'const loaded = import("../demo/index.js");',
  "const loaded = import(`../demo/index.js`);",
  'const loaded = require("../demo/index.js");',
  'import loaded = require("../demo/index.js");',
  'type Loaded = import("../demo/index.js").Value;',
  'const load = require; const again = load; again("../demo/index.js");',
  'import { createRequire as makeRequire } from "node:module"; const load = makeRequire(import.meta.url); load("../demo/index.js");',
  'import { value } from "../demo/../demo/index.js";',
])("refuses cross-bundle imports: %s", async (source) => {
  // Given production-shaped, untracked modules using different namespaces.
  const root = fixture({
    [audit]: `// entry\n${source}`,
    [demo]: "export const value = 1; export type Value = number;",
  });
  // When the real dependency CLI scans the fixture.
  const result = await run(root);
  // Then the source edge, not a manifest or type error, refuses the import.
  expect(result.code).toBe(1);
  expect(result.error).toContain(`BUNDLE_CROSS_NAMESPACE ${audit}:2`);
});

test("refuses tsconfig aliases inherited by the app", async () => {
  const root = fixture({
    "tsconfig.base.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "#demo/*": ["apps/openomni/src/bundles/demo/*"] } },
    }),
    "apps/openomni/tsconfig.json": JSON.stringify({
      extends: "../../tsconfig.base.json",
      include: ["src"],
    }),
    [audit]: 'import { value } from "#demo/index";',
    [demo]: "export const value = 1;",
  });
  const result = await run(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain(`BUNDLE_CROSS_NAMESPACE ${audit}:1`);
});

test.each([
  'export * from "./bundles/demo/index.js";',
  'import { value } from "./bundles/demo/index.js"; export const indirect = value;',
  'export type Value = import("./bundles/demo/index.js").Value;',
])("refuses laundering through an app barrel: %s", async (source) => {
  const root = fixture({
    [audit]: 'import * as bridge from "../../bridge.js";',
    "apps/openomni/src/bridge.ts": 'export * from "./cycle.js";',
    "apps/openomni/src/cycle.ts": `export * from "./bridge.js";\n${source}`,
    [demo]: "export const value = 1; export type Value = number;",
  });
  const result = await run(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain("BUNDLE_CROSS_NAMESPACE apps/openomni/src/cycle.ts:2");
});

test.each([
  "import(destination);",
  `import(\`../\${namespace}/index.js\`);`,
  'require("../" + namespace + "/index.js");',
  "const load = require; load(destination);",
])("refuses computed paths reachable by a bundle: %s", async (source) => {
  const root = fixture({
    [audit]: 'import "../../bridge.js";',
    "apps/openomni/src/bridge.ts": source,
  });
  const result = await run(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain("BUNDLE_COMPUTED_IMPORT apps/openomni/src/bridge.ts:1");
});

test("allows same namespace, external dependencies, approved core barrels and app composition", async () => {
  const root = fixture({
    [audit]:
      'import "./internal.js"; import type { PlainValue } from "@openomni/protocol"; import { Layer } from "effect";',
    "apps/openomni/src/bundles/audit-log/internal.ts":
      'export * from "./index.js"; const text = \'import("../demo/index.js")\'; function local(require: (s: string) => string) { return require("../demo/index.js"); }',
    [demo]: "export const value = 1;",
    "apps/openomni/src/composition.ts":
      'import "./bundles/audit-log/index.js"; import "./bundles/demo/index.js";',
  });
  expect((await run(root)).code).toBe(0);
});

test("manifest layer order: allowed @openomni deps pass, inverted deps fail", async () => {
  const manifest = (name: string, deps: Record<string, string>) =>
    JSON.stringify({ name, dependencies: deps });
  const allowed = fixture({
    "packages/agent/package.json": manifest("@openomni/agent", {
      "@openomni/protocol": "workspace:*",
      typescript: "catalog:",
    }),
  });
  expect((await run(allowed)).code).toBe(0);

  const inverted = fixture({
    "packages/protocol/package.json": manifest("@openomni/protocol", {
      "@openomni/agent": "workspace:*",
    }),
  });
  const result = await run(inverted);
  expect(result.code).toBe(1);
  expect(result.error).toContain(
    "VIOLATION: protocol depends on @openomni/agent — not allowed by layer order",
  );
});

test("rejects malformed dependency maps instead of treating them as empty", async () => {
  const root = fixture({
    "packages/protocol/package.json": JSON.stringify({
      name: "@openomni/protocol",
      dependencies: ["@openomni/agent"],
    }),
  });
  await expect(runInProcess(root)).rejects.toThrow();
});

test("accepts a clean repository with no dependency or doc warnings", async () => {
  // Nested in the existing worktree so git can establish that these new docs have no history.
  // No index, commit or git configuration is changed.
  const docs = [
    "",
    "packages/protocol/",
    "packages/agent/",
    "packages/machines/",
    "packages/channels/",
  ];
  const root = fixture(
    Object.fromEntries(docs.map((directory) => [`${directory}AGENTS.md`, ""])),
    import.meta.dir,
  );
  const result = await run(root);
  expect(result.code).toBe(0);
  // The fixture is not a git checkout, so the #1343 token-pin slack skip and
  // the #1346 allow-list presence skip are each announced loudly (exactly
  // once) instead of passing silently.
  expect(result.error).toBe(
    "NOTICE [check-deps] token pin slack not judged: . is not a git checkout\n" +
      "NOTICE [check-deps] session-write allow-list presence not judged: . is not a git checkout\n",
  );
});

test.each([
  ["import {", "BUNDLE_PARSE_ERROR"],
  ['import "./missing.js";', "BUNDLE_UNRESOLVED_IMPORT"],
  ['const loaded = require("@openomni/ui");', "BUNDLE_IMPORT_NOT_ALLOWED"],
  ['type Loaded = import("@openomni/agent/src/services").Clock;', "BUNDLE_IMPORT_NOT_ALLOWED"],
])("fails closed for %s", async (source, code) => {
  const root = fixture({ [audit]: source });
  const result = await run(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain(`${code} ${audit}:1`);
});

test.each([
  'import * as Module from "node:module"; const load = Module.createRequire(import.meta.url); load("../demo/index.js");',
  'import { load } from "../../loader.js"; load("../demo/index.js");',
  'import * as Module from "node:module"; const { createRequire: make } = Module; const load = make(import.meta.url); load("../demo/index.js");',
  'import Module from "node:module"; const load = Module["createRequire"](import.meta.url); load("../demo/index.js");',
  'import * as Module from "node:module"; const alias = Module; const load = alias.createRequire(import.meta.url); load("../demo/index.js");',
  'const load = (require as typeof require); load("../demo/index.js");',
])("refuses loader aliases crossing a barrel: %s", async (source) => {
  const root = fixture({
    [audit]: source,
    [demo]: "export const value = 1;",
    "apps/openomni/src/loader.ts": 'export { load } from "./loader-origin.js";',
    "apps/openomni/src/loader-origin.ts": "export const load = require;",
  });
  expect(await checkBundleImports(root)).toContainEqual({
    code: "BUNDLE_CROSS_NAMESPACE",
    file: audit,
    line: 1,
  });
  expect((await run(root)).code).toBe(1);
});

test.each([
  '{ "compilerOptions": { "target": "invalid" } }',
  '{ "extends": "./missing.json" }',
  '{ "compilerOptions": ',
])("refuses invalid resolution configuration: %s", async (config) => {
  const root = fixture({
    [audit]: 'import "../demo/index.js";',
    [demo]: "export {};",
    "apps/openomni/tsconfig.json": config,
  });
  const result = await run(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain("BUNDLE_CONFIG_ERROR apps/openomni/tsconfig.json:");
});

test("refuses a config that exists but cannot be read", async () => {
  const config = "apps/openomni/tsconfig.json";
  const root = fixture({ [audit]: "export {};", [config]: "{}" });
  chmodSync(join(root, config), 0o000);
  try {
    expect(await checkBundleImports(root)).toEqual([
      { code: "BUNDLE_CONFIG_ERROR", file: config, line: 1 },
    ]);
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.error).toContain(`BUNDLE_CONFIG_ERROR ${config}:1`);
  } finally {
    chmodSync(join(root, config), 0o600);
  }
});

test("refuses a resolved local file excluded from the compiler program", async () => {
  const root = fixture({
    [audit]: 'import "#shared";',
    "shared/api.ts": "export const value = 1;",
    "apps/openomni/tsconfig.json": JSON.stringify({
      compilerOptions: { noResolve: true, paths: { "#shared": ["../../shared/api.ts"] } },
      include: ["src"],
    }),
  });
  expect(await checkBundleImports(root)).toEqual([
    { code: "BUNDLE_UNRESOLVED_IMPORT", file: "shared/api.ts", line: 1 },
  ]);
  const result = await run(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain("BUNDLE_UNRESOLVED_IMPORT shared/api.ts:1");
});

test("allows a repository without production bundles and ignores isolated test fixtures", async () => {
  const root = fixture({
    "apps/openomni/test/bundles/audit/index.ts": 'import "../demo/index.js";',
    "apps/openomni/src/bundles/demo/example.test.ts": 'import "../audit/index.js";',
  });
  expect(await checkBundleImports(root)).toEqual([]);
});

test("allows composition outside the reserved namespace directories", async () => {
  const root = fixture({
    "apps/openomni/src/bundles/index.ts":
      'export * from "./audit-log/index.js"; export * from "./demo/index.js";',
    [audit]: "export const audit = 1;",
    [demo]: "export const demo = 2;",
  });
  expect(await checkBundleImports(root)).toEqual([]);
});

test("follows require edges into shared barrels", async () => {
  const root = fixture({
    [audit]: 'const shared = require("../../shared.js");',
    "apps/openomni/src/shared.ts": 'export * from "./bundles/demo/index.js";',
    [demo]: "export {};",
  });
  expect(await checkBundleImports(root)).toContainEqual({
    code: "BUNDLE_CROSS_NAMESPACE",
    file: "apps/openomni/src/shared.ts",
    line: 1,
  });
});

test("refuses unresolved aliases instead of treating them as external dependencies", async () => {
  const root = fixture({
    [audit]: 'import "bundle/demo";',
    "apps/openomni/tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "bundle/*": ["./src/bundles/*"] } },
      include: ["src"],
    }),
  });
  expect(await checkBundleImports(root)).toEqual([
    { code: "BUNDLE_UNRESOLVED_IMPORT", file: audit, line: 1 },
  ]);
});

test.each([
  [
    "source dependency",
    "packages/protocol/src/illegal.ts",
    'import { Session } from "@openomni/agent";',
    "not allowed by layer order",
  ],
  [
    "channels driver dependency",
    "packages/channels/src/provider/driver.ts",
    'import { DecisionFacts } from "@openomni/agent";',
    "S8 banding",
  ],
  [
    "channels driver router edge",
    "packages/channels/src/provider/driver.ts",
    'import { route } from "../router/index.js";',
    "drivers may not reach into src/router/",
  ],
  [
    "channels brain store access",
    "packages/channels/src/router/illegal.ts",
    'import { Session } from "@openomni/agent";',
    "names agent surface Session",
  ],
  [
    "deep package import",
    "packages/agent/src/illegal.ts",
    'import { Session } from "@openomni/protocol/src/session";',
    "use package barrel instead",
  ],
  [
    "deep relative import",
    "packages/agent/src/illegal.ts",
    'import { value } from "../../../packages/protocol/src/index";',
    "deep relative import",
  ],
  [
    "type suppression",
    "packages/agent/src/illegal.ts",
    "// @ts-ignore",
    "type suppression directive",
  ],
  [
    "empty catch",
    "packages/agent/src/illegal.ts",
    "try { value() } catch {}",
    "empty catch block",
  ],
])("refuses %s through the real dependency gate", async (_name, path, source, message) => {
  const root = fixture({ [path]: source });
  const result = await run(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain(message);
});

test("ignores test and untracked research sources in dependency scans", async () => {
  const root = fixture({
    "packages/protocol/test/illegal.test.ts": 'import "@openomni/agent/src/index";',
    "tmp/illegal.ts": 'import "@openomni/agent/src/index";',
    ".claude/illegal.ts": 'import "@openomni/agent/src/index";',
  });
  expect((await run(root)).code).toBe(0);
});

test("dependency self-test discriminates its source and perimeter bands", () => {
  const result = Bun.spawnSync([process.execPath, checker, "--self-test"], {
    cwd: join(import.meta.dir, ".."),
    timeout: 15_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("layer discriminations hold");
});

test("in-process self-test exercises the dependency and perimeter rules", async () => {
  const cwd = process.cwd();
  const code = process.exitCode;
  const messages: string[] = [];
  const log = spyOn(console, "log").mockImplementation((message: string) => {
    messages.push(message);
  });
  process.chdir(join(import.meta.dir, ".."));
  Bun.argv.push("--self-test");
  try {
    await main();
    expect(process.exitCode).toBe(0);
    expect(messages.join("")).toContain("layer discriminations hold");
  } finally {
    Bun.argv.pop();
    process.chdir(cwd);
    process.exitCode = code ?? 0;
    log.mockRestore();
  }
});

test("missing package manifest fails closed before source scanning", async () => {
  const root = fixture({});
  rmSync(join(root, "packages/protocol/package.json"));
  await expect(runInProcess(root)).rejects.toThrow("Missing required file: packages/protocol/package.json");
});

test("deep-import fix suggestions retain the package barrel identity", async () => {
  const root = fixture({
    "packages/agent/src/illegal.ts": 'import "@openomni/protocol/src/session";',
  });
  Bun.argv.push("--fix-suggestions");
  try {
    const result = await runInProcess(root);
    expect(result.code).toBe(1);
    expect(result.error).toContain("suggestion: @openomni/protocol");
  } finally {
    Bun.argv.pop();
  }
});

test("rejects self-root imports, unsafe casts, and catch-all source filenames", async () => {
  const root = fixture({
    "packages/agent/src/utils.ts": 'import { value } from "../../src/core";\nconst result = value as any;',
  });
  const result = await runInProcess(root);
  expect(result.code).toBe(1);
  expect(result.error).toContain("self-root relative import");
  expect(result.error).toContain("`as any` detected");
  expect(result.error).toContain("catch-all filename detected");
});

test("missing tracked docs emit a warning without failing the dependency check", async () => {
  const result = await runInProcess(fixture({}));
  expect(result.code).toBe(0);
  expect(result.error).toContain("WARNING: tracked doc missing: AGENTS.md");
  expect(result.output).toContain("no violations, but");
});

test("doc freshness distinguishes new, stale, and unreadable history without git writes", async () => {
  const root = fixture({
    "AGENTS.md": "",
    "packages/protocol/AGENTS.md": "",
    "packages/machines/AGENTS.md": "",
  });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const warnings = await checkDocFreshness(async (args) => {
      if (args[0] === "log") {
        if (args[4] === "AGENTS.md") return "";
        if (args[4] === "packages/protocol/AGENTS.md") return "abc";
        throw new Error("git unavailable");
      }
      return "50";
    });
    expect(warnings).toContain(
      "STALE: packages/protocol/AGENTS.md — last updated 50 commits ago (threshold: 50)",
    );
    expect(warnings).toContain("WARNING: doc freshness unavailable for packages/machines/AGENTS.md");
    expect(warnings).toContain("WARNING: tracked doc missing: packages/agent/AGENTS.md");
    expect(warnings).not.toContain("WARNING: doc freshness unavailable for AGENTS.md");
  } finally {
    process.chdir(cwd);
  }
});

test("doc freshness reports unavailable git history outside a repository", async () => {
  const root = fixture({ "AGENTS.md": "" });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    expect(await checkDocFreshness()).toContain(
      "WARNING: doc freshness unavailable for AGENTS.md",
    );
  } finally {
    process.chdir(cwd);
  }
});

test("in-process Python gate rejects warning diagnostics and accepts clean source", () => {
  const root = fixture({
    "clean.py": "def identity(value: int) -> int:\n    return value\n",
    "warning.py": "def identity(value):\n    return value\n",
  });
  expect(checkPython(["--file", join(root, "clean.py")])).toBe(0);
  expect(checkPython(["--file", join(root, "warning.py")])).toBe(1);
});

test("in-process Python gate rejects checker version drift and invalid flags", () => {
  const root = fixture({ "checker": "#!/bin/sh\nprintf 'basedpyright 0.0.0\\n'\n" });
  const executable = join(root, "checker");
  chmodSync(executable, 0o700);
  const previous = process.env.BASEDPYRIGHT;
  const errors: string[] = [];
  const error = spyOn(console, "error").mockImplementation((message: string) => {
    errors.push(message);
  });
  process.env.BASEDPYRIGHT = executable;
  try {
    expect(checkPython([])).toBe(2);
    expect(errors).toContain("basedpyright 1.39.10 is required");
    expect(() => checkPython(["--update"])).toThrow();
  } finally {
    error.mockRestore();
    if (previous === undefined) delete process.env.BASEDPYRIGHT;
    else process.env.BASEDPYRIGHT = previous;
  }
});

test("#1276 bands: a planted core->plugins import emits a VIOLATION line", () => {
  const found = agentBandViolations(
    "packages/agent/src/core/planted.ts",
    'import { restore } from "../plugins/compaction/restore";',
  );
  expect(found).toHaveLength(1);
  expect(found[0]).toStartWith("VIOLATION: packages/agent/src/core/planted.ts:1");
});

test("#1276 ratchet: growth over the pinned baseline fails, within-baseline passes", async () => {
  const clean = fixture({
    "packages/agent/src/core/pure.ts": 'import { ok } from "./other";',
  });
  expect(await validateAgentBands(clean)).toEqual([]);

  // core/commit.ts is pinned at 1; a second violation in it must fail
  // (#1352 retired the model band, so the probe edge is inspect/).
  const grown = fixture({
    "packages/agent/src/core/commit.ts":
      'import { a } from "../plugins/compaction/restore";\nimport { b } from "../inspect/history";',
  });
  const violations = await validateAgentBands(grown);
  expect(violations.some((line) => line.includes("over the #1276 ratchet of 1"))).toBe(true);

  // Exactly at the pinned count: that file passes. The other pinned files are
  // absent from this scratch tree, so the review r3 slack rule reports each of
  // them (pin exceeds actual) — slack never passes silently.
  const pinned = fixture({
    "packages/agent/src/core/commit.ts": 'import { a } from "../plugins/compaction/restore";',
  });
  const atPin = await validateAgentBands(pinned);
  expect(atPin.filter((line) => line.includes("core/commit.ts"))).toEqual([]);
  expect(atPin.every((line) => line.includes("pin exceeds actual"))).toBe(true);
});

test("#1276 bands: external bans catch exact and prefixed specifiers, legal externals pass", () => {
  const exact = agentBandViolations(
    "packages/agent/src/core/planted.ts",
    'import { generateText } from "ai";',
  );
  expect(exact).toHaveLength(1);
  expect(exact[0]).toContain("core/ may not depend on ai");

  const prefixed = agentBandViolations(
    "packages/agent/src/core/planted.ts",
    'import { anthropic } from "@ai-sdk/anthropic";',
  );
  expect(prefixed).toHaveLength(1);
  expect(prefixed[0]).toContain("core/ may not depend on @ai-sdk/");

  // A sub-path of an exact ban is banned too; an unrelated external is legal.
  const subPath = agentBandViolations(
    "packages/agent/src/core/planted.ts",
    'import { rsc } from "ai/rsc";',
  );
  expect(subPath).toHaveLength(1);
  expect(
    agentBandViolations("packages/agent/src/core/planted.ts", 'import { Effect } from "effect";'),
  ).toEqual([]);
});

test("#1247 S8 pin: the real agent index passes, a grown name fails", async () => {
  const real = await Bun.file(join(import.meta.dir, "..", "packages/agent/src/index.ts")).text();
  expect(agentIndexPerimeterViolations(real)).toEqual([]);

  const grown = `${real}\nexport { somethingNew } from "./kernel/turn";\n`;
  const violations = agentIndexPerimeterViolations(grown);
  expect(violations.some((line) => line.includes("exports somethingNew outside the pinned S8 perimeter"))).toBe(true);
});

test("#1247 S8 pin: an eighth namespace and a non-barrel export form fail; shrink passes", () => {
  const extraNamespace = agentIndexPerimeterViolations('export * as Extra from "./extra";\n');
  expect(extraNamespace.some((line) => line.includes("namespace Extra outside the five #1276 namespaces"))).toBe(true);

  const declaration = agentIndexPerimeterViolations("export const leak = 1;\n");
  expect(declaration.some((line) => line.includes("export form outside the #1276 surface"))).toBe(true);

  const shrunk = agentIndexPerimeterViolations(
    'export * as Core from "./core";\nexport { evaluatePermission } from "./core/gate/match";\n',
  );
  expect(shrunk).toEqual([]);
});

test("#1247 S8 pin: alias, indentation, and missing semicolon cannot smuggle a name", () => {
  // The EXPORTED name (after `as`) is what goes public; the pinned local name must not whitelist it.
  const aliased = agentIndexPerimeterViolations(
    'export { evaluatePermission as rogue } from "./kernel/gate/match";\n',
  );
  expect(aliased.some((line) => line.includes("exports rogue outside the pinned S8 perimeter"))).toBe(true);

  const indented = agentIndexPerimeterViolations('  export { rogue } from "./kernel/turn";\n');
  expect(indented.some((line) => line.includes("exports rogue outside the pinned S8 perimeter"))).toBe(true);

  const semicolonFree = agentIndexPerimeterViolations('export { rogue } from "./kernel/turn"\n');
  expect(semicolonFree.some((line) => line.includes("exports rogue outside the pinned S8 perimeter"))).toBe(true);

  // Aliasing a pinned name onto another pinned name stays within the perimeter.
  const pinnedAlias = agentIndexPerimeterViolations(
    'export { decisionFromEvaluation as evaluatePermission } from "./kernel/gate/match";\n',
  );
  expect(pinnedAlias).toEqual([]);
});

test("#1247 S8 pin: unaliased star export and default export are rejected forms", () => {
  const star = agentIndexPerimeterViolations('export * from "./kernel";\n');
  expect(star.some((line) => line.includes("export form outside the #1276 surface"))).toBe(true);

  const defaulted = agentIndexPerimeterViolations("const x = 1;\nexport default x;\n");
  expect(defaulted.some((line) => line.includes("export form outside the #1276 surface"))).toBe(true);
});

test("#1247 S8 pin: a seventh named export trips the count diagnostic itself", () => {
  const names = [
    "decisionFromEvaluation",
    "evaluatePermission",
    "PolicyEvaluationInput",
    "requireSubAdapter",
    "withStoreTimestamps",
    "createDecisionFactPort",
    // Seventh entry re-exports a pinned name under a second pinned alias, so
    // every NAME stays pinned and only the count rule can catch the growth.
    "evaluatePermission as decisionFromEvaluation",
  ];
  const source = names.map((name) => `export { ${name} } from "./kernel/gate/match";`).join("\n");
  const violations = agentIndexPerimeterViolations(source);
  expect(violations).toContain(
    "VIOLATION: packages/agent/src/index.ts has 7 named exports over the pinned 6 — shrink only, never grow",
  );
});

test("#1247 S8 pin: validateAgentIndexPerimeter reads the pinned file and tolerates its absence", async () => {
  const clean = fixture({});
  expect(await validateAgentIndexPerimeter(clean)).toEqual([]);

  const planted = fixture({
    "packages/agent/src/index.ts": 'export { rogue } from "./kernel/turn";\n',
  });
  const violations = await validateAgentIndexPerimeter(planted);
  expect(violations.some((line) => line.includes("exports rogue outside the pinned S8 perimeter"))).toBe(true);
});

// ─── #1255: retired-surface conformance ─────────────────────────────────────
// ONE conformance assertion over the issue body's "tokens that must return no
// output" (the deleted monitor tool/ports files, the imperative session-tool
// constructors, bundle names in boot, the legacy compose plane, kernel-row
// @openomni/llm references, the ambient cron grid). It reads the LIVE
// repository via import.meta.dir — never a fixture — so a regrowth of any
// retired surface names the file that grew it.

const repoRoot = join(import.meta.dir, "..");

const RETIRED_SURFACES: Readonly<Record<string, { pattern: RegExp; globs: readonly string[] }>> = {
  "monitor tool/ports files": {
    pattern: /./,
    globs: ["apps/openomni/src/tools/monitor.ts", "apps/openomni/src/composition/monitor-ports.ts"],
  },
  "sessionTool(/toolSpec( in the agent": {
    pattern: /sessionTool\(|toolSpec\(/,
    globs: ["packages/agent/src/**/*.ts"],
  },
  "bundle name 'monitor' in boot": { pattern: /monitor/, globs: ["apps/openomni/src/index.ts"] },
  "legacy compose plane BundlesLive": {
    pattern: /BundlesLive/,
    globs: ["apps/*/src/**/*.ts", "packages/agent/src/**/*.ts"],
  },
  "@openomni/llm in kernel rows": { pattern: /@openomni\/llm/, globs: ["packages/agent/src/**/*.ts"] },
  "ambient Bun.cron( grid": { pattern: /Bun\.cron\(/, globs: ["apps/**/*.ts", "packages/**/*.ts"] },
};

async function tokenMatches(pattern: RegExp, globs: readonly string[]): Promise<string[]> {
  const hits: string[] = [];
  for (const glob of globs) {
    for await (const file of new Bun.Glob(glob).scan({ cwd: repoRoot })) {
      const source = await Bun.file(join(repoRoot, file)).text();
      if (pattern.test(source)) hits.push(file);
    }
  }
  return hits.sort();
}

test("#1255: every retired surface greps to zero in the live repository", async () => {
  const hits: Record<string, string[]> = {};
  for (const [surface, { pattern, globs }] of Object.entries(RETIRED_SURFACES)) {
    hits[surface] = await tokenMatches(pattern, globs);
  }
  const expected = Object.fromEntries(Object.keys(RETIRED_SURFACES).map((surface) => [surface, []]));
  expect(hits).toEqual(expected);
});

test("#1345 ban: a seeded app use of a retired ledger constructor or host import is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "check-deps-1345-"));
  try {
    const seeded = join(root, "apps/openomni/src/composition/seeded.ts");
    mkdirSync(dirname(seeded), { recursive: true });
    writeFileSync(
      seeded,
      [
        'import { Core } from "@openomni/agent";',
        'import { SingleRunner } from "effect/cluster";',
        "const catalog = Core.openCatalogStore(\":memory:\", { now: () => 1 });",
        "export { catalog, SingleRunner };",
      ].join("\n"),
    );
    // A test file under apps/ is outside the scan, like every dependency rule.
    writeFileSync(join(root, "apps/openomni/src/composition/seeded.test.ts"), "Core.openSessionStore;\n");
    expect(await validateAppsAgentBarrel(root)).toEqual([
      "VIOLATION: apps/openomni/src/composition/seeded.ts:2 imports effect/cluster — #1345: the core host owns the runner and SQLite client",
      "VIOLATION: apps/openomni/src/composition/seeded.ts:3 names openCatalogStore — #1345: apps open the ledger through Core.openLedger only",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1345 ban: every retired name and import form fails; comments, strings and other packages pass", () => {
  const source = [
    "// openCatalogStore is mentioned in prose only",
    'const text = "createSessionEntityLayer";',
    "const { openSessionStore } = Core;",
    "type Run = typeof Core.createSessionEntityRunTurn;",
    "Core.createSessionEntityLayer(drain);",
    "const plane = Testing.openLedgerPlane({ now: () => 1 });",
    'export * from "@effect/sql-sqlite-bun";',
    'const lazy = import("effect/cluster/SingleRunner");',
  ].join("\n");
  expect(appsRetiredHostViolations("apps/openomni/src/x.ts", source).map((line) => line.split(" — ")[0])).toEqual([
    "VIOLATION: apps/openomni/src/x.ts:3 names openSessionStore",
    "VIOLATION: apps/openomni/src/x.ts:4 names createSessionEntityRunTurn",
    "VIOLATION: apps/openomni/src/x.ts:5 names createSessionEntityLayer",
    "VIOLATION: apps/openomni/src/x.ts:6 names openLedgerPlane",
    "VIOLATION: apps/openomni/src/x.ts:7 imports @effect/sql-sqlite-bun",
    "VIOLATION: apps/openomni/src/x.ts:8 imports effect/cluster/SingleRunner",
  ]);
  expect(appsRetiredHostViolations("packages/agent/src/core/host.ts", source)).toEqual([]);
});
