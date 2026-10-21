import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { publishAudit } from "./quality-audit-issues";
import { planChanges } from "./ci-plan";
import { census } from "./check-types-census";
import { buildInventory, readContract } from "./quality-inventory";
import { mergeNativeLines, type NativeLines, parseNativeLcov } from "./quality-native-lcov";
import {
  measureTypescriptFunctions,
  type FunctionMetrics,
  type TypescriptMetricContract,
} from "./quality-typescript-metrics";

const ROOT = resolve(import.meta.dir, "..");
const count = z.number().int().nonnegative();
const repoPath = z
  .string()
  .min(1)
  .refine((path) => !isAbsolute(path) && !path.split("/").includes("..") && !path.includes("\\"));
export const findingKinds = [
  "coverage",
  "complexity",
  "cyclomatic",
  "halstead",
  "crap",
  "clones",
  "types",
] as const;

/** Owned-origin any/unknown sites only: a foreign row is reached solely through
 * declarations outside the campaign (zod internals, lib.d.ts) and is not our
 * debt. Identical (path, line, kind, symbol) rows collapse into one count. */
export function typeFindings(
  violations: readonly { path: string; line: number; kind: string; symbol: string; origin: string }[],
): Finding[] {
  const merged = new Map<string, Finding>();
  for (const row of violations) {
    if (row.origin !== "owned") continue;
    const message = `${row.kind} (owned): ${row.symbol}`;
    const key = `${row.path}\u0000${row.line}\u0000${message}`;
    const found = merged.get(key);
    if (found) found.count += 1;
    else merged.set(key, { path: row.path, kind: "types", line: row.line, count: 1, message });
  }
  return [...merged.values()];
}
const findingSchema = z.object({
  path: repoPath,
  kind: z.enum(findingKinds),
  line: count,
  count: z.number().int().positive(),
  message: z.string().min(1),
});
export type Finding = z.infer<typeof findingSchema>;
export const totalsSchema = z.object({
  coverage: count,
  complexity: count,
  cyclomatic: count,
  halstead: count,
  crap: count,
  clones: count,
  types: count,
});
export const auditSchema = z
  .object({
    version: z.literal(1),
    head: z.string().regex(/^[a-f0-9]{40}$/),
    runUrl: z.url(),
    generatedAt: z.iso.datetime(),
    complete: z.boolean(),
    missingLanes: z.array(z.string()),
    tools: z.object({
      coverage: z.string(),
      complexity: z.string(),
      typescriptMetrics: z.string(),
      clones: z.string(),
      types: z.string(),
    }),
    mutation: z.literal("see quality-mutation.yml"),
    coverage: z.array(
      z.object({ path: repoPath, lines: count, covered: count, loaded: z.boolean() }),
    ),
    findings: z.array(findingSchema),
    totals: totalsSchema,
  })
  .superRefine((audit, ctx) => {
    const totals = findingTotals(audit.findings);
    if (findingKinds.some((kind) => totals[kind] !== audit.totals[kind]))
      ctx.addIssue({ code: "custom", message: "Finding totals differ" });
    if (audit.complete && audit.missingLanes.length)
      ctx.addIssue({ code: "custom", message: "Complete audit has missing lanes" });
    if (audit.coverage.some((row) => row.covered > row.lines))
      ctx.addIssue({ code: "custom", message: "Coverage hits exceed lines" });
  });
export type Audit = z.infer<typeof auditSchema>;

export function findingTotals(findings: readonly Finding[]) {
  const totals = {
    coverage: 0,
    complexity: 0,
    cyclomatic: 0,
    halstead: 0,
    crap: 0,
    clones: 0,
    types: 0,
  };
  for (const finding of findings) totals[finding.kind] += finding.count;
  return totals;
}

export function typescriptMetricFindings(
  metrics: readonly FunctionMetrics[],
  contract: TypescriptMetricContract,
): Finding[] {
  return metrics.flatMap((row) => {
    const findings: Finding[] = [];
    if (row.cyclomatic >= contract.cyclomaticExclusiveMax)
      findings.push({
        path: row.path,
        kind: "cyclomatic",
        line: row.line,
        count: 1,
        message: `${row.symbol} cyclomatic ${row.cyclomatic} >= ${contract.cyclomaticExclusiveMax}`,
      });
    if (row.halsteadDifficulty >= contract.halsteadDifficultyExclusiveMax)
      findings.push({
        path: row.path,
        kind: "halstead",
        line: row.line,
        count: 1,
        message: `${row.symbol} Halstead difficulty ${row.halsteadDifficulty.toFixed(3)} >= ${contract.halsteadDifficultyExclusiveMax}`,
      });
    if (row.crap >= contract.crapExclusiveMax)
      findings.push({
        path: row.path,
        kind: "crap",
        line: row.line,
        count: 1,
        message: `${row.symbol} CRAP ${row.crap.toFixed(3)} >= ${contract.crapExclusiveMax}`,
      });
    return findings;
  });
}

export function aggregateFiles(findings: readonly Finding[]) {
  const files = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = files.get(finding.path) ?? [];
    group.push(finding);
    files.set(finding.path, group);
  }
  return [...files]
    .map(([path, rows]) => ({
      path,
      findings: rows,
      count: rows.reduce((sum, row) => sum + row.count, 0),
    }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path, "en"));
}

export function coverageFindings(records: readonly NativeLines[], sources: readonly string[]) {
  const merged = mergeNativeLines(records);
  const loaded = new Map(merged.map((record) => [record.path, record]));
  // Only inventoried sources are audited: lanes also load test helpers and
  // fixtures, and their uncovered lines are not product debt.
  const paths = [...new Set(sources)].sort();
  const coverage = paths.map((path) => {
    const record = loaded.get(path);
    return {
      path,
      lines: record?.lines.length ?? 0,
      covered: record?.lines.filter((line) => line.hits > 0).length ?? 0,
      loaded: record !== undefined,
    };
  });
  const findings: Finding[] = coverage
    .filter((row) => !row.loaded || row.lines > row.covered)
    .map((row) => ({
      path: row.path,
      kind: "coverage",
      line: 0,
      count: Math.max(1, row.lines - row.covered),
      message: row.loaded
        ? `${row.covered}/${row.lines} executable lines covered`
        : "No LCOV record; coverage not measured",
    }));
  return { coverage, findings };
}

const biomeSchema = z.object({
  summary: z.object({ diagnosticsNotPrinted: count }),
  diagnostics: z.array(
    z.object({
      category: z.string(),
      message: z.string(),
      location: z.object({ path: z.string(), start: z.object({ line: count }).optional() }),
    }),
  ),
});
export function complexityFindings(text: string): Finding[] {
  const report = biomeSchema.parse(JSON.parse(text));
  if (report.summary.diagnosticsNotPrinted) throw new Error("Truncated Biome diagnostics");
  return report.diagnostics.map((row) => {
    if (row.category !== "lint/complexity/noExcessiveCognitiveComplexity")
      throw new Error(`Unexpected Biome diagnostic: ${row.category}: ${row.message}`);
    return {
      path: sourcePath(row.location.path),
      kind: "complexity",
      line: row.location.start?.line ?? 0,
      count: 1,
      message: row.message,
    };
  });
}

const fragmentSchema = z.object({ name: z.string(), start: z.number().int().positive() });
const cloneSchema = z.object({
  statistics: z.object({ total: z.object({ sources: z.number().int().positive() }) }),
  duplicates: z.array(
    z.object({ firstFile: fragmentSchema, secondFile: fragmentSchema, lines: count }),
  ),
});
function sourcePath(path: string) {
  return repoPath.parse(isAbsolute(path) ? relative(ROOT, path) : path.replace(/^\.\//, ""));
}
export function cloneFindings(text: string, scope: "production" | "test"): Finding[] {
  return cloneSchema.parse(JSON.parse(text)).duplicates.flatMap((clone) =>
    (
      [
        [clone.firstFile, clone.secondFile],
        [clone.secondFile, clone.firstFile],
      ] as const
    ).map(([file, other]) => ({
      path: sourcePath(file.name),
      kind: "clones" as const,
      line: file.start,
      count: 1,
      message: `${scope}: ${clone.lines} duplicated lines with ${sourcePath(other.name)}:${other.start}`,
    })),
  );
}

export function auditLanes() {
  return [
    ...planChanges([], true).matrix.include,
    { key: "scripts-contracts", dir: "script", coverage: true },
  ];
}

export async function auditCommand(args: string[], accepted = [0], input?: string, cwd = ROOT) {
  const child = Bun.spawn(args, {
    cwd,
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (!accepted.includes(code))
    throw new Error(`${args.join(" ")} exited ${code}: ${stderr || stdout}`);
  return stdout;
}

function readCoverage(directory: string) {
  const records: NativeLines[] = [];
  const missingLanes: string[] = [];
  for (const lane of auditLanes().filter((row) => row.coverage)) {
    const path = join(directory, `coverage-${lane.key}`, "lcov.info");
    if (!existsSync(path)) {
      missingLanes.push(lane.key);
      continue;
    }
    records.push(...parseNativeLcov(readFileSync(path, "utf8"), lane.dir));
  }
  return { records, missingLanes };
}

export function collectTypes(root = ROOT) {
  const contract = readContract(join(root, "script/conformance/quality-contract.json"));
  const inventory = buildInventory(root, contract);
  return { root, contract, inventory, types: census(root, contract, inventory) };
}

export async function measure(
  directory: string,
  command = auditCommand,
  readTypes = collectTypes,
  env: Record<string, string | undefined> = process.env,
): Promise<Audit> {
  const head = (await command(["git", "rev-parse", "HEAD"])).trim();
  const biome = await command(
    [
      process.execPath,
      "x",
      "biome",
      "lint",
      "--only=complexity/noExcessiveCognitiveComplexity",
      "--reporter=json",
      "--max-diagnostics=none",
      ".",
    ],
    [0, 1],
  );
  const findings = complexityFindings(biome);
  for (const scope of ["production", "test"] as const) {
    const output = join(directory, `clones-${scope}`);
    await command([
      process.execPath,
      "run",
      `quality:clones:${scope}`,
      "--output",
      output,
      "--fail-on-empty",
      "--silent",
    ]);
    findings.push(
      ...cloneFindings(await Bun.file(join(output, "jscpd-report.json")).text(), scope),
    );
  }
  const { root, contract, inventory, types } = readTypes();
  if (!types.complete) throw new Error(`Incomplete type census: ${JSON.stringify(types.errors)}`);
  findings.push(...typeFindings(types.violations));
  const evidence = readCoverage(directory);
  const sources = inventory.files
    .filter(
      (file) =>
        ["production", "tooling"].includes(file.category) &&
        ["typescript", "javascript"].includes(file.language) &&
        !file.path.endsWith(".d.ts"),
    )
    .map((file) => file.path);
  const coverage = coverageFindings(evidence.records, sources);
  findings.push(...coverage.findings);
  if (!contract.metrics) throw new Error("Quality contract has no TypeScript metric contract");
  const coverageByPath = new Map(
    mergeNativeLines(evidence.records).map((record) => [record.path, record.lines]),
  );
  const functionMetrics = sources.flatMap((path) =>
    measureTypescriptFunctions(
      path,
      readFileSync(join(root, path), "utf8"),
      coverageByPath.get(path) ?? [],
    ),
  );
  findings.push(...typescriptMetricFindings(functionMetrics, contract.metrics));
  const repository = env.GITHUB_REPOSITORY ?? "INONONO66/oni";
  const runUrl = env.GITHUB_RUN_ID
    ? `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
    : `https://github.com/${repository}/commit/${head}`;
  return auditSchema.parse({
    version: 1,
    head,
    runUrl,
    generatedAt: new Date().toISOString(),
    complete: evidence.missingLanes.length === 0,
    missingLanes: evidence.missingLanes,
    tools: {
      coverage: "bun test --coverage --coverage-reporter=lcov (CI lanes)",
      complexity:
        "biome@2.4.16 noExcessiveCognitiveComplexity >21 (including configured overrides)",
      typescriptMetrics:
        `${contract.metrics.tool}@${contract.metrics.version} ${contract.metrics.algorithm}; ` +
        `${contract.metrics.coverage}`,
      clones: "jscpd@5.3.0, production/test separately, minLines=5 minTokens=50",
      types: "check-types-census.ts (owned origin only)",
    },
    mutation: "see quality-mutation.yml",
    coverage: coverage.coverage,
    findings,
    totals: findingTotals(findings),
  });
}

type AuditIO = {
  measure: (directory: string) => Promise<Audit>;
  write: (path: string, text: string) => Promise<number>;
  print: (text: string) => void;
  gh?: Parameters<typeof publishAudit>[1];
};
export async function auditMain(
  args = Bun.argv.slice(2),
  io: AuditIO = { measure, write: Bun.write, print: console.log },
) {
  const { values } = parseArgs({
    args,
    options: {
      matrix: { type: "boolean" },
      "dry-run": { type: "boolean" },
      publish: { type: "boolean" },
      "coverage-root": { type: "string", default: "quality-audit-input" },
    },
  });
  if (values.matrix) {
    io.print(JSON.stringify({ include: auditLanes() }));
    return;
  }
  if (values.publish && values["dry-run"]) throw new Error("Choose publish or dry-run");
  const audit = await io.measure(resolve(ROOT, values["coverage-root"]));
  await io.write(join(ROOT, "quality-audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
  const { planIssues, publishAudit } = await import("./quality-audit-issues");
  if (values["dry-run"]) {
    io.print(
      JSON.stringify(
        {
          audit,
          issuePlan: planIssues(audit, []),
          note: "Offline preview assumes no existing summary; no gh calls. Missing lanes are not publishable.",
        },
        null,
        2,
      ),
    );
  } else {
    if (!audit.complete)
      throw new Error(`Missing coverage lanes: ${audit.missingLanes.join(", ")}`);
    if (values.publish) await publishAudit(audit, io.gh);
    io.print(JSON.stringify({ output: "quality-audit.json", totals: audit.totals }));
  }
}

if (import.meta.main) await auditMain();
