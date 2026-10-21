import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  aggregateFiles,
  auditCommand,
  auditLanes,
  auditMain,
  auditSchema,
  cloneFindings,
  collectTypes,
  complexityFindings,
  coverageFindings,
  findingTotals,
  measure,
  typescriptMetricFindings,
  type Finding,
  typeFindings,
} from "./quality-audit";
import { measureTypescriptFunctions, type TypescriptMetricContract } from "./quality-typescript-metrics";
import { planChanges } from "./ci-plan";

const finding: Finding = {
  path: "script/a.ts",
  kind: "types",
  line: 1,
  count: 2,
  message: "type sites",
};
function document() {
  return {
    version: 1,
    head: "a".repeat(40),
    runUrl: "https://github.com/owner/repo/actions/runs/1",
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
    findings: [finding],
    totals: findingTotals([finding]),
  };
}

test("audit schema accepts a JSON boundary and retains typed totals", () => {
  expect(auditSchema.parse(JSON.parse(JSON.stringify(document()))).totals.types).toBe(2);
});

test("audit schema rejects invalid identity, escaping paths and counts", () => {
  expect(() => auditSchema.parse({ ...document(), head: "bad" })).toThrow();
  for (const path of ["../secret", "/secret", "a/../b", "a\\b", ""]) {
    expect(() => auditSchema.parse({ ...document(), findings: [{ ...finding, path }] })).toThrow();
  }
  expect(() =>
    auditSchema.parse({ ...document(), findings: [{ ...finding, count: -1 }] }),
  ).toThrow();
});

test("audit schema refuses mismatched totals and incomplete coverage claims", () => {
  expect(() =>
    auditSchema.parse({
      ...document(),
      totals: {
        coverage: 0,
        complexity: 0,
        cyclomatic: 0,
        halstead: 0,
        crap: 0,
        clones: 0,
        types: 1,
      },
    }),
  ).toThrow();
  expect(() => auditSchema.parse({ ...document(), missingLanes: ["agent"] })).toThrow();
  expect(() =>
    auditSchema.parse({
      ...document(),
      coverage: [{ path: "a.ts", loaded: true, lines: 1, covered: 2 }],
    }),
  ).toThrow();
  expect(
    auditSchema.parse({ ...document(), complete: false, missingLanes: ["agent"] }).complete,
  ).toBe(false);
});

test("aggregation sums finding counts and sorts ties deterministically by path", () => {
  const findings: Finding[] = [
    finding,
    { ...finding, kind: "coverage", count: 3 },
    { ...finding, path: "script/b.ts", count: 5 },
    { ...finding, path: "script/c.ts", count: 6 },
  ];
  expect(aggregateFiles(findings).map((file) => [file.path, file.count])).toEqual([
    ["script/c.ts", 6],
    ["script/a.ts", 5],
    ["script/b.ts", 5],
  ]);
  expect(findingTotals(findings)).toEqual({
    coverage: 3,
    complexity: 0,
    cyclomatic: 0,
    halstead: 0,
    crap: 0,
    clones: 0,
    types: 13,
  });
  expect(aggregateFiles([])).toEqual([]);
});

test("coverage unions lane hits and distinguishes missing source records", () => {
  const result = coverageFindings(
    [
      {
        path: "a.ts",
        lines: [
          { line: 1, hits: 1 },
          { line: 2, hits: 0 },
        ],
      },
      {
        path: "a.ts",
        lines: [
          { line: 1, hits: 0 },
          { line: 2, hits: 1 },
        ],
      },
      {
        path: "b.ts",
        lines: [
          { line: 1, hits: 0 },
          { line: 2, hits: 0 },
        ],
      },
      // Loaded by a lane but not an inventoried source (test helper): ignored.
      { path: "test/helpers/h.ts", lines: [{ line: 1, hits: 0 }] },
    ],
    ["a.ts", "b.ts", "c.ts"],
  );
  expect(result.coverage).toEqual([
    { path: "a.ts", loaded: true, lines: 2, covered: 2 },
    { path: "b.ts", loaded: true, lines: 2, covered: 0 },
    { path: "c.ts", loaded: false, lines: 0, covered: 0 },
  ]);
  expect(result.findings.map((row) => [row.path, row.count])).toEqual([
    ["b.ts", 2],
    ["c.ts", 1],
  ]);
});

test("coverage preserves zero-line loaded modules without a debt finding", () => {
  const result = coverageFindings([{ path: "types.ts", lines: [] }], ["types.ts"]);
  expect(result.coverage).toEqual([{ path: "types.ts", loaded: true, lines: 0, covered: 0 }]);
  expect(result.findings).toEqual([]);
});

test("complexity parses the pinned Biome JSON diagnostic shape", () => {
  const report = {
    summary: { diagnosticsNotPrinted: 0 },
    diagnostics: [
      {
        category: "lint/complexity/noExcessiveCognitiveComplexity",
        message: "complexity 24",
        severity: "info",
        location: { path: "./script/a.ts", start: { line: 12, column: 4 } },
      },
    ],
  };
  expect(complexityFindings(JSON.stringify(report))).toEqual([
    { path: "script/a.ts", kind: "complexity", line: 12, count: 1, message: "complexity 24" },
  ]);
  expect(() =>
    complexityFindings(JSON.stringify({ ...report, summary: { diagnosticsNotPrinted: 1 } })),
  ).toThrow();
  expect(() =>
    complexityFindings(
      JSON.stringify({ ...report, diagnostics: [{ ...report.diagnostics[0], category: "parse" }] }),
    ),
  ).toThrow();
  expect(() => complexityFindings("{}")).toThrow();
});

const metricContract: TypescriptMetricContract = {
  algorithm: "oni-typescript-function-metrics-v1",
  tool: "typescript",
  version: "5.9.2",
  coverage: "lcov-da-line-fraction-v1",
  cyclomaticExclusiveMax: 22,
  halsteadDifficultyExclusiveMax: 80,
  crapExclusiveMax: 25,
};
const metricFixture = measureTypescriptFunctions(
  "src/choose.ts",
  [
    "export function choose(a: number, b: number, flag: boolean) {",
    "  if (flag) return a + b;",
    "  return a - b;",
    "}",
  ].join("\n"),
  [
    { line: 2, hits: 1 },
    { line: 3, hits: 0 },
  ],
)[0];
if (!metricFixture) throw new Error("metric fixture did not produce a function");

test("TypeScript function names resolve across declaration shapes", () => {
  const source = [
    "class Widget {",
    "  constructor() { this.size = 1; }",
    "  handler = function () { return 1; };",
    "}",
    "const arrow = () => 1;",
    "const literal = { nested: function () { return 2; } };",
    "[1].map(function () { return 3; });",
  ].join("\n");
  expect(
    measureTypescriptFunctions("src/names.ts", source, []).map((metric) => metric.symbol),
  ).toEqual(["constructor", "handler", "arrow", "nested", "<function@7>"]);
});

test("TypeScript AST cyclomatic metric matches the hand-computed fixture", () => {
  expect(metricFixture.cyclomatic).toBe(2);
});

test("TypeScript AST Halstead difficulty matches the hand-computed fixture", () => {
  expect(metricFixture.halsteadDifficulty).toBe(2.5);
});

test("TypeScript AST CRAP uses the fixture's one-half LCOV line coverage", () => {
  expect(metricFixture.coverage).toBe(0.5);
  expect(metricFixture.crap).toBe(2.5);
});

test("TypeScript metric thresholds are exclusive zero-baseline findings", () => {
  const metric = {
    ...metricFixture,
    cyclomatic: 22,
    halsteadDifficulty: 80,
    crap: 25,
  };
  expect(typescriptMetricFindings([metric], metricContract).map((finding) => finding.kind)).toEqual([
    "cyclomatic",
    "halstead",
    "crap",
  ]);
});

test("clone parsing accounts for both endpoints in separate scan scopes", () => {
  const report = JSON.stringify({
    statistics: { total: { sources: 2 } },
    duplicates: [
      {
        firstFile: { name: "script/a.ts", start: 2 },
        secondFile: { name: "script/b.ts", start: 8 },
        lines: 6,
      },
    ],
  });
  const findings = cloneFindings(report, "production");
  expect(findings.map((row) => [row.path, row.line, row.kind])).toEqual([
    ["script/a.ts", 2, "clones"],
    ["script/b.ts", 8, "clones"],
  ]);
  expect(findingTotals(findings).clones).toBe(2);
  expect(cloneFindings(report, "test")).toHaveLength(2);
  expect(() =>
    cloneFindings('{"statistics":{"total":{"sources":0}},"duplicates":[]}', "test"),
  ).toThrow();
});

test("audit lane matrix is the full CI plan plus contracts without duplicates", () => {
  const lanes = auditLanes();
  expect(lanes.slice(0, -1)).toEqual([...planChanges([], true).matrix.include]);
  expect(lanes.at(-1)).toEqual({ key: "scripts-contracts", dir: "script", coverage: true });
  expect(new Set(lanes.map((lane) => lane.key)).size).toBe(lanes.length);
});

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quality-audit-test-"));
  directories.push(root);
  mkdirSync(join(root, "script/conformance"), { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/value.ts"), "export const value = 1;\n");
  // Lane lcov paths resolve under the lane's workspace; an inventoried file
  // there is what the coverage audit reports on.
  mkdirSync(join(root, "packages/agent/src"), { recursive: true });
  writeFileSync(join(root, "packages/agent/src/value.ts"), "export const value = 1;\n");
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        types: [],
      },
      include: ["src/*.ts"],
    }),
  );
  writeFileSync(
    join(root, "script/conformance/quality-contract.json"),
    JSON.stringify({
      version: 1,
      typescript: "5.9.2",
      metrics: metricContract,
      roots: ["src", "packages/agent/src"],
      projects: ["tsconfig.json"],
      topology: false,
    }),
  );
  return root;
}

function fakeTools() {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "git") return "a".repeat(40);
    if (args.includes("biome"))
      return JSON.stringify({ summary: { diagnosticsNotPrinted: 0 }, diagnostics: [] });
    const output = args[args.indexOf("--output") + 1];
    if (!output) throw new Error("Missing clone output argument");
    await Bun.write(
      join(output, "jscpd-report.json"),
      JSON.stringify({
        statistics: { total: { sources: 1 } },
        duplicates: [],
      }),
    );
    return "";
  };
  return { run, calls };
}

test("collector combines typed census and isolated lane receipts, preserving missing lanes", async () => {
  const root = fixture();
  const result = collectTypes(root);
  expect(result.types.complete).toBe(true);
  const typed = {
    ...result,
    types: {
      ...result.types,
      violations: [
        {
          path: "src/value.ts",
          line: 1,
          offset: 0,
          symbol: "value",
          kind: "implicitAny" as const,
          origin: "owned" as const,
        },
      ],
    },
  };
  const fake = fakeTools();
  const partial = await measure(root, fake.run, () => typed, {});
  expect(partial.missingLanes).toHaveLength(auditLanes().length);
  expect(partial.complete).toBe(false);
  expect(partial.totals.types).toBe(1);
  expect(partial.runUrl).toBe(`https://github.com/INONONO66/oni/commit/${"a".repeat(40)}`);
  for (const lane of auditLanes()) {
    await Bun.write(
      join(root, `coverage-${lane.key}`, "lcov.info"),
      "SF:src/value.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n",
    );
  }
  const complete = await measure(root, fake.run, () => result, {
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_RUN_ID: "12",
  });
  expect(complete.complete).toBe(true);
  expect(complete.runUrl).toBe("https://github.com/owner/repo/actions/runs/12");
  expect(
    complete.coverage.some(
      (row) => row.path === "packages/agent/src/value.ts" && row.covered === 1,
    ),
  ).toBe(true);
  expect(fake.calls.some((args) => args.includes("quality:clones:production"))).toBe(true);
  expect(fake.calls.some((args) => args.includes("quality:clones:test"))).toBe(true);
  await expect(
    measure(root, fake.run, () => ({ ...result, types: { ...result.types, complete: false } })),
  ).rejects.toThrow();
}, 15_000);

test("command boundary drains output and rejects process failures without network", async () => {
  expect(await auditCommand([process.execPath, "-e", "process.stdout.write('receipt')"])).toBe(
    "receipt",
  );
  await expect(
    auditCommand([process.execPath, "-e", "console.error('failed');process.exit(2)"]),
  ).rejects.toThrow("exited 2");
  expect(await auditCommand([process.execPath, "-e", "process.exit(1)"], [1])).toBe("");
});

test("CLI dry-run prints schema-valid JSON and operations without invoking gh", async () => {
  const output: string[] = [],
    writes: string[] = [];
  const current = auditSchema.parse({ ...document(), complete: false, missingLanes: ["agent"] });
  const io = {
    measure: () => Promise.resolve(current),
    write: (_path: string, text: string) => {
      writes.push(text);
      return Promise.resolve(text.length);
    },
    print: (text: string) => {
      output.push(text);
    },
    gh: () => Promise.reject(new Error("dry-run must not invoke gh")),
  };
  await auditMain(["--dry-run"], io);
  const preview = z
    .object({
      audit: auditSchema,
      issuePlan: z.object({
        firstRun: z.boolean(),
        operation: z.object({ action: z.literal("create"), title: z.string() }),
      }),
    })
    .parse(JSON.parse(output[0] ?? ""));
  expect(preview.audit.complete).toBe(false);
  expect(preview.issuePlan.operation.title).toBe("quality: audit summary");
  expect(auditSchema.parse(JSON.parse(writes[0] ?? "")).totals).toEqual(current.totals);
  await expect(auditMain(["--publish", "--dry-run"], io)).rejects.toThrow();
  await expect(auditMain([], io)).rejects.toThrow();
  output.length = 0;
  await auditMain(["--matrix"], io);
  expect(
    z
      .object({ include: z.array(z.object({ key: z.string() })) })
      .parse(JSON.parse(output[0] ?? ""))
      .include.map((lane) => lane.key),
  ).toEqual(auditLanes().map((lane) => lane.key));
});

test("CLI publishing uses injected gh results, and measurement-only does not publish", async () => {
  const calls: string[][] = [];
  const output: string[] = [];
  const io = {
    measure: () => Promise.resolve(auditSchema.parse(document())),
    write: (_path: string, text: string) => Promise.resolve(text.length),
    print: (text: string) => {
      output.push(text);
    },
    gh: (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "repo") return Promise.resolve('{"nameWithOwner":"owner/repo"}');
      return Promise.resolve(args.includes("--paginate") ? "[[]]" : '{"number":1}');
    },
  };
  await auditMain([], io);
  expect(calls).toHaveLength(0);
  await auditMain(["--publish"], io);
  expect(calls.some((args) => args.includes("--method"))).toBe(true);
  expect(output).toHaveLength(2);
});

test("typeFindings keeps owned rows only and folds duplicate sites into one count", () => {
  const row = { path: "src/a.ts", line: 5, offset: 0, symbol: "Step", kind: "implicitAny", origin: "owned" };
  const result = typeFindings([
    row,
    { ...row, offset: 3 },
    { ...row, kind: "unknown" },
    { ...row, origin: "foreign" },
    { ...row, path: "src/b.ts", origin: "foreign", kind: "unknown" },
  ]);
  expect(result).toEqual([
    { path: "src/a.ts", kind: "types", line: 5, count: 2, message: "implicitAny (owned): Step" },
    { path: "src/a.ts", kind: "types", line: 5, count: 1, message: "unknown (owned): Step" },
  ]);
});
