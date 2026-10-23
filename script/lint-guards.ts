import { runScriptMain } from "./main-runner";
import { verifyPinnedFilesExist } from "./lint-side-effects";

type GuardRuleId =
  | "ad-hoc-list-membership"
  | "inline-channel-trigger-evaluation"
  | "inline-authorization-throw"
  | "missing-canonical-policy-evaluator"
  | "run-reason-code-vocabulary";

interface GuardViolation {
  readonly ruleId: GuardRuleId;
  readonly filePath: string;
  readonly line: number;
  readonly message: string;
}

interface SourceMatch {
  readonly index: number;
  readonly text: string;
  readonly captured?: string;
}

const scanRoots = ["packages", "apps"];
const excludedPathParts = ["/dist/", "/node_modules/", "/coverage/", "/generated/"];
const excludedSuffixes = [".d.ts", ".generated.ts", ".gen.ts"];

// Only the canonical permission evaluator leaf may implement raw allowlist/denylist
// membership; every public caller still routes through evaluatePermission
// (the agent gate, the engine's owner since #498 W1; folded into agent by #1246).
const canonicalPolicyEvaluator = new Set(["packages/agent/src/core/gate/bind.ts"]);
const canonicalPolicyRequiredFiles = new Set(["packages/channels/src/authn/decision.ts"]);

const listMembershipPattern = /\b(?:denylist|allowlist)\s*\??\.\s*includes\s*\(/g;
const channelNormalizerTriggerPattern = /\bevaluateTriggers\s*\(/g;
const inlineAuthorizationThrowPatterns = [
  /if\s*\(\s*!\s*(?:[\w$]+\.)*(?:isAuthorized|authorized|hasAuthority|hasPermission|isAllowed|canAuthorize)(?:\s*\([^)]*\))?\s*\)\s*(?:\{\s*)?throw\b/gi,
  /if\s*\(\s*(?:[\w$]+\.)*(?:isAuthorized|authorized|hasAuthority|hasPermission|isAllowed|canAuthorize)\s*(?:===\s*false|!==\s*true)\s*\)\s*(?:\{\s*)?throw\b/gi,
];
/**
 * The run loop's closed reason-code vocabulary, declared once in
 * `packages/agent/src/core/ports/reason-codes.ts` and produced from another
 * package, so a literal at the producer is a coupling the compiler cannot see:
 * rename one end and the loop silently stops reacting.
 *
 * Scoped to shipped source, at the two positions a rename starts: producers
 * (`reasonCodes:` arrays) and consumers (equality or `.includes` against one
 * of the values). Deliberately NOT matched elsewhere: `"stalled"` is also a
 * value of the unrelated `AgentResult.finishReason` union, and a test that
 * asserts the literal is the pin proving the constant's value — routing those
 * through the constant would make them pass no matter what it became. A code
 * reaching a `reasonCodes` array through a variable or helper parameter is
 * also out of reach; the test pins are the layer that catches a wrong value.
 */
const runReasonCodeSource = "packages/agent/src/core/ports/reason-codes.ts";
const runReasonCodeLiteralPattern =
  /reasonCodes:\s*\[[^\]]*?["'`](stalled|budget_warning|budget_reassurance)["'`]/g;
const runReasonCodeComparisonPattern =
  /(?:[!=]==\s*|\.includes\()["'`](stalled|budget_warning|budget_reassurance)["'`]/g;

/**
 * File-path allowlists go silently vacuous when a scanned file is renamed or
 * deleted: `missing-canonical-policy-evaluator` only fires for a path in
 * `canonicalPolicyRequiredFiles`, so a rename removes the file from the set's
 * reach and the rule stops checking it with no signal. Assert every pinned
 * path exists so a rename fails loud here instead (mirrors
 * lint-side-effects.ts's "Missing hot file" guard).
 */
export async function main(): Promise<void> {
  await verifyPinnedFilesExist(
    [...canonicalPolicyEvaluator, ...canonicalPolicyRequiredFiles],
    (filePath) =>
      `Missing pinned guard file: ${filePath} — a rule that keys off this path would silently go vacuous; update lint-guards.ts if the rename/deletion is intentional`,
  );
  const files = await collectSourceFiles();
  const violations: GuardViolation[] = [];

  for (const filePath of files) {
    const source = await Bun.file(filePath).text();
    violations.push(...validateGuardSource(filePath, source));
  }

  if (violations.length === 0) {
    process.stdout.write(`OK: guard lint scanned ${files.length} TypeScript files\n`);
    return;
  }

  for (const violation of violations) {
    process.stderr.write(
      `VIOLATION: ${violation.filePath}:${violation.line} [${violation.ruleId}] — ${violation.message}\n`,
    );
  }

  process.exit(1);
}

export function validateGuardSource(filePath: string, source: string): GuardViolation[] {
  return [
    ...validateCanonicalPolicyUsage(filePath, source),
    ...validateChannelTriggerEvaluation(filePath, source),
    ...validateListMembership(filePath, source),
    ...validateInlineAuthorization(filePath, source),
    ...validateRunReasonCodeVocabulary(filePath, source),
  ];
}

async function collectSourceFiles(): Promise<string[]> {
  const files = new Set<string>();

  for (const root of scanRoots) {
    const glob = new Bun.Glob(`${root}/**/*.ts`);
    for await (const filePath of glob.scan({
      cwd: ".",
      absolute: false,
      dot: false,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      if (!shouldSkip(filePath)) {
        files.add(filePath);
      }
    }
  }

  return Array.from(files).sort((left, right) => left.localeCompare(right));
}

function shouldSkip(filePath: string): boolean {
  if (excludedSuffixes.some((suffix) => filePath.endsWith(suffix))) {
    return true;
  }

  return excludedPathParts.some((part) => filePath.includes(part));
}

function validateCanonicalPolicyUsage(filePath: string, source: string): GuardViolation[] {
  if (!canonicalPolicyRequiredFiles.has(filePath) || source.includes("evaluatePermission(")) {
    return [];
  }

  return [
    {
      ruleId: "missing-canonical-policy-evaluator",
      filePath,
      line: 1,
      message:
        "migrated policy middleware must route permission verdicts through evaluatePermission",
    },
  ];
}

function validateChannelTriggerEvaluation(filePath: string, source: string): GuardViolation[] {
  if (!filePath.startsWith("packages/channels/src/") || !filePath.endsWith("/normalizer.ts")) {
    return [];
  }

  return matches(source, channelNormalizerTriggerPattern).map((match) => ({
    ruleId: "inline-channel-trigger-evaluation",
    filePath,
    line: lineNumberForOffset(source, match.index),
    message: "channel normalizers must leave trigger authorization to channel-authn middleware",
  }));
}

function validateListMembership(filePath: string, source: string): GuardViolation[] {
  if (canonicalPolicyEvaluator.has(filePath)) {
    return [];
  }

  return matches(source, listMembershipPattern).map((match) => ({
    ruleId: "ad-hoc-list-membership",
    filePath,
    line: lineNumberForOffset(source, match.index),
    message:
      "denylist/allowlist membership must go through evaluatePermission instead of inline includes",
  }));
}

function validateInlineAuthorization(filePath: string, source: string): GuardViolation[] {
  return inlineAuthorizationThrowPatterns.flatMap((pattern) =>
    matches(source, pattern).map((match) => ({
      ruleId: "inline-authorization-throw",
      filePath,
      line: lineNumberForOffset(source, match.index),
      message:
        "inline authorization throws belong in approved middleware or policy implementation files",
    })),
  );
}

function validateRunReasonCodeVocabulary(filePath: string, source: string): GuardViolation[] {
  // Test files are the pin layer (see the vocabulary comment above), so a
  // co-located src test is excluded structurally, not by convention.
  if (
    filePath === runReasonCodeSource ||
    !filePath.includes("/src/") ||
    filePath.endsWith(".test.ts")
  ) {
    return [];
  }

  return [
    ...matches(source, runReasonCodeLiteralPattern),
    ...matches(source, runReasonCodeComparisonPattern),
  ].map((match) => ({
    filePath,
    line: lineNumberForOffset(source, match.index),
    ruleId: "run-reason-code-vocabulary",
    message: `run reason code "${match.captured}" written as a literal; use RunReasonCode from @oni/agent so a rename fails the build instead of the run loop`,
  }));
}

function matches(source: string, pattern: RegExp): SourceMatch[] {
  pattern.lastIndex = 0;
  const results: SourceMatch[] = [];

  let match = pattern.exec(source);
  while (match !== null) {
    results.push({ index: match.index, text: match[0], captured: match[1] });
    match = pattern.exec(source);
  }

  return results;
}

function lineNumberForOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

if (import.meta.main) await runScriptMain(main);
