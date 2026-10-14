import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { commandOutput } from "./command-output";
import { CORE_END_STATE_TARGETS as TARGET } from "./core-end-state-targets";
import { runScriptMain } from "./main-runner";

const ROOT = join(import.meta.dir, "..");
const SRC = "packages/agent/src/";
const CORE = `${SRC}core/`;
const RETIRED = /ModelPort|model-port|@openomni\/model|retry-loop|seam|core\/mailbox|legacy-rows|\bworker\b/gi;
type VocabularyPin = { readonly file: string; readonly token: string; readonly count: number; readonly owner: string };
type VocabularyExclusions = {
  readonly quotedIdentifiers: readonly string[];
  readonly quotedLiterals: readonly VocabularyPin[];
};

/** App port identifiers retire independently of persisted keys and module paths. */
export function appPortVocabularyViolations(file: string, source: string): string[] {
  if (!file.startsWith("apps/openomni/src/")) return [];
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text.includes("Seam")) {
      const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
      violations.push(`VIOLATION: ${file}:${line} names retired app port identifier ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return violations;
}

export function agentSourceFacts(file: string, source: string, exclusions: VocabularyExclusions = TARGET.vocabularyExclusions) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const quotedPattern = new RegExp(`(["'\`])(?:${exclusions.quotedIdentifiers.join("|")})\\1`, "g");
  const quoted: (readonly [number, number])[] = [...source.matchAll(quotedPattern)].map((match) => [match.index, match.index + match[0].length] as const);
  const pinViolations: string[] = [];
  for (const pin of exclusions.quotedLiterals.filter((entry) => entry.file === file)) {
    const ranges = [...source.matchAll(new RegExp(pin.token, "g"))].map((match) => [match.index, match.index + match[0].length] as const);
    if (ranges.length !== pin.count) pinViolations.push(`VIOLATION: ${file} vocabulary pin ${pin.token} ${pin.count} != actual ${ranges.length}: lower retired pins, never grow`);
    quoted.push(...ranges);
  }
  const retired = [...source.matchAll(RETIRED)].filter((match) =>
    !quoted.some(([start, end]) => match.index >= start && match.index < end),
  );
  const facts = {
    retiredTokens: retired.length,
    pinViolations,
    forbiddenPatterns: 0,
    alarmFolds: 0,
    alarmComposers: 0,
    coreAlarmComposers: 0,
    pluginAlarmComposers: 0,
    emptyThrows: 0,
    lines: source.split("\n").length - Number(source.endsWith("\n")),
  };
  const visit = (node: ts.Node): void => {
    const name = ts.isFunctionDeclaration(node) && node.body !== undefined ? node.name?.text : undefined;
    facts.alarmFolds += Number(name === "foldAlarmChain" || name === "foldAlarmChains");
    const composer = name === "composeAlarmPurposes";
    facts.alarmComposers += Number(composer);
    facts.coreAlarmComposers += Number(composer && file.startsWith(CORE));
    facts.pluginAlarmComposers += Number(composer && file.startsWith(`${SRC}plugins/alarm/`));
    facts.forbiddenPatterns += forbiddenSourceNode(node, file);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "toThrow" && node.arguments.length === 0) facts.emptyThrows += 1;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return facts;
}

function forbiddenSourceNode(node: ts.Node, file: string): number {
  if (ts.isStringLiteralLike(node) && isModuleSpecifier(node)) {
    return Number(/^(?:ai(?:\/|$)|@ai-sdk\/)/.test(node.text)) +
      Number(file.startsWith(CORE) && /(?:^\.{1,2}\/(?:.*\/)?model(?:\/|\.|$)|plugins\/|^(?:node:)?child_process$)/.test(node.text));
  }
  if (!file.startsWith(CORE)) return 0;
  if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    ts.isIdentifier(node.expression) && node.expression.text === "Bun") {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text :
      ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : "";
    return Number(name === "spawn" || name === "spawnSync");
  }
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
    node.initializer && ts.isIdentifier(node.initializer) && node.initializer.text === "Bun") {
    return node.name.elements.filter((binding) => {
      const name = binding.propertyName ?? binding.name;
      return (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
        (name.text === "spawn" || name.text === "spawnSync");
    }).length;
  }
  return 0;
}

function isModuleSpecifier(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  return ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) ||
    (ts.isExternalModuleReference(parent) && parent.expression === node) ||
    (ts.isCallExpression(parent) && parent.arguments[0] === node &&
      (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(parent.expression) && parent.expression.text === "require")));
}

async function* agentFiles(root: string, exclusions: VocabularyExclusions) {
  for (const scope of ["src", "test"] as const) {
    for await (const file of new Bun.Glob(`packages/agent/${scope}/**/*.{ts,tsx}`).scan({ cwd: root, onlyFiles: true })) {
      yield { scope, file, facts: agentSourceFacts(file, await Bun.file(join(root, file)).text(), exclusions) };
    }
  }
}

export async function checkCoreEndState(root = ROOT, exclusions: VocabularyExclusions = TARGET.vocabularyExclusions): Promise<string[]> {
  const totals = {
    retiredTokens: 0, forbiddenPatterns: 0, alarmFolds: 0, alarmComposers: 0,
    coreAlarmComposers: 0, pluginAlarmComposers: 0, emptyThrows: 0,
    longSourceFiles: 0, longTestFiles: 0,
  };
  const violations: string[] = [];
  const files = { src: 0, test: 0 };
  const seen = new Set<string>();
  for await (const { scope, file, facts } of agentFiles(root, exclusions)) {
    seen.add(file);
    violations.push(...facts.pinViolations);
    files[scope] += 1;
    const lineLimit = scope === "src" ? TARGET.sourceLineLimit : TARGET.testLineLimit;
    if (facts.lines > lineLimit) {
      totals[scope === "src" ? "longSourceFiles" : "longTestFiles"] += 1;
      violations.push(`VIOLATION: ${file} has ${facts.lines} lines > ${lineLimit}`);
    }
    const keys = scope === "src"
      ? ["retiredTokens", "forbiddenPatterns", "alarmFolds", "alarmComposers", "coreAlarmComposers", "pluginAlarmComposers"] as const
      : ["emptyThrows"] as const;
    for (const key of keys) totals[key] += facts[key];
    const problems = scope === "src" ? facts.retiredTokens + facts.forbiddenPatterns : facts.emptyThrows;
    if (problems > 0) violations.push(`VIOLATION: ${file} has ${problems} forbidden source/assertion matches`);
  }
  for await (const file of new Bun.Glob("apps/openomni/src/**/*.{ts,tsx}").scan({ cwd: root, onlyFiles: true })) {
    violations.push(...appPortVocabularyViolations(file, await Bun.file(join(root, file)).text()));
  }
  violations.push(...exclusions.quotedLiterals
    .filter((pin) => !seen.has(pin.file))
    .map((pin) => `VIOLATION: vocabulary pin owner missing: ${pin.file}`));
  violations.push(...Object.entries(files).filter(([, count]) => count === 0)
    .map(([scope]) => `VIOLATION: empty agent ${scope} census`));
  for (const key of ["retiredTokens", "forbiddenPatterns", "alarmFolds", "alarmComposers", "coreAlarmComposers", "emptyThrows", "longSourceFiles", "longTestFiles"] as const) {
    if (totals[key] !== TARGET[key]) violations.push(`VIOLATION: ${key} ${totals[key]} != terminal ${TARGET[key]}`);
  }
  if (totals.pluginAlarmComposers !== TARGET.alarmComposers) violations.push("VIOLATION: composeAlarmPurposes must have exactly one plugin/alarm owner");
  return violations;
}

const CloneReport = z.object({
  statistics: z.object({ total: z.object({
    clones: z.number().int().nonnegative(),
    duplicatedLines: z.number().int().nonnegative(),
    lines: z.number().int().positive(),
    sources: z.number().int().positive(),
  }) }),
});

export function cloneEndStateViolations(source: string, scope: "production" | "test", inheritedPin?: number): string[] {
  const parsed = CloneReport.safeParse(JSON.parse(source));
  if (!parsed.success) return ["VIOLATION: missing or invalid clone census"];
  const total = parsed.data.statistics.total;
  if (inheritedPin !== undefined) {
    const actual = scope === "production" ? total.clones : total.duplicatedLines;
    return actual === inheritedPin ? [] : [
      `VIOLATION: ${scope} inherited clone count ${actual} != pin ${inheritedPin}: growth is forbidden; shrinkage must lower the pin`,
    ];
  }
  const actual = scope === "production" ? total.clones : 100 * total.duplicatedLines / total.lines;
  const target = scope === "production" ? TARGET.productionClones : TARGET.testClonePercent;
  return actual > target ? [`VIOLATION: ${scope} clones ${actual} > terminal ${target}`] : [];
}

async function checkClones(scope: "production" | "test"): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "core-clones-"));
  try {
    const result = await commandOutput([
      process.execPath, "run", `quality:clones:${scope}`, "packages/agent", "--output", directory, "--fail-on-empty", "--silent",
    ], ROOT);
    if (result.exitCode !== 0) return [`VIOLATION: clone scan exited ${result.exitCode}: ${result.stderr}`];
    const pin = scope === "production" ? TARGET.inheritedClones.production.count : TARGET.inheritedClones.test.duplicatedLines;
    return cloneEndStateViolations(await Bun.file(join(directory, "jscpd-report.json")).text(), scope, pin);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function main(): Promise<void> {
  const violations = [
    ...await checkCoreEndState(),
    ...await checkClones("production"),
    ...await checkClones("test"),
  ];
  for (const violation of violations) console.error(violation);
  if (violations.length > 0) process.exitCode = 1;
  else console.log("OK: core terminal source, alarm, size and assertion targets; inherited clone pins match");
}

if (import.meta.main) await runScriptMain(main);
