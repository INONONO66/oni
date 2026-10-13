import { join } from "node:path";
import ts from "typescript";
import { runScriptMain } from "./main-runner";

const ROOT = join(import.meta.dir, "..");
const AGENT_SRC_GLOB = "packages/agent/src/**/*.ts";

/**
 * Comment-residue gate for packages/agent sources: tight per-file pins (pin
 * === HEAD actual, so growth and slack both fail) for unlisted issue-number
 * lines and decorative dividers, a package comment-ratio CEILING, a tight
 * JSDoc>6 pin, and an enumerated issue-number allow-list.
 */
export interface FileResidue {
  readonly issueLines: number;
  readonly dividerLines: number;
  readonly commentLines: number;
  readonly nonblankLines: number;
  readonly jsdocOverSix: number;
  /** Allow-listed markers found as comment-only lines, so stale entries fail closed. */
  readonly listedNotes: readonly string[];
}

/** One issue-number comment line exempted from the unlisted-hit count. */
export interface DurableByteNote {
  readonly file: string;
  /** The exact trimmed comment line; a pattern never qualifies. */
  readonly marker: string;
  /** Why durable byte compatibility needs the number, not a general exemption. */
  readonly reason: string;
}

export interface ResiduePins {
  /** file -> [unlisted issue-number comment lines, divider lines], sorted, explicit zeroes. */
  readonly files: ReadonlyMap<string, readonly [number, number]>;
  /**
   * Package comment-to-nonblank ratio CEILING in basis points: only growth
   * fails. Slack passes, because adding plain code lowers the ratio and must
   * not fail the gate; a cleanup lowers the ceiling deliberately.
   */
  readonly ratioBasisPoints: number;
  /**
   * Package count of JSDoc blocks spanning more than six lines. TIGHT pin:
   * growth AND slack fail, because this count only moves when a JSDoc block
   * is edited, never when plain code is added.
   */
  readonly jsdocOverSix: number;
  /** Enumerated issue-number notes (<= DURABLE_BYTE_NOTE_BUDGET), each with a path and reason. */
  readonly durableByteNotes: readonly DurableByteNote[];
}

/** Hard budget for durable-byte-contract notes, enforced by the gate itself. */
const DURABLE_BYTE_NOTE_BUDGET = 10;

const ISSUE_TOKEN = /#\d{3,4}/;
/** A comment-only line whose text, past any `//`, `/*` or `*` prefix, opens with a box-drawing run. */
const DIVIDER = /^(?:\/\/|\/\*+|\*+)?\s*─{3,}/;
const WHITESPACE = /\s/;

/**
 * Comment lines come from TypeScript comment trivia, never line-prefix
 * heuristics: a nonblank line is a comment line only when every non-whitespace
 * character sits inside a comment range, so trailing comments and template
 * text that looks like `//` are code. `allowedNotes` are exact trimmed lines.
 */
export function classifyResidue(
  source: string,
  allowedNotes: ReadonlySet<string> = new Set(),
): FileResidue {
  const { commentMask, jsdocOverSix } = commentTrivia(source);
  const listedNotes: string[] = [];
  const tally = { issueLines: 0, dividerLines: 0, commentLines: 0, nonblankLines: 0, jsdocOverSix };
  let offset = 0;
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      tally.nonblankLines += 1;
      if (isCommentOnly(raw, offset, commentMask)) {
        tally.commentLines += 1;
        if (ISSUE_TOKEN.test(trimmed)) {
          if (allowedNotes.has(trimmed)) listedNotes.push(trimmed);
          else tally.issueLines += 1;
        }
        if (DIVIDER.test(trimmed)) tally.dividerLines += 1;
      }
    }
    offset += raw.length + 1;
  }
  return { ...tally, listedNotes };
}

/** Character mask of comment trivia plus the JSDoc>6 count, from the parsed file's tokens. */
function commentTrivia(source: string): { commentMask: Uint8Array; jsdocOverSix: number } {
  const sourceFile = ts.createSourceFile(
    "residue.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const commentMask = new Uint8Array(source.length);
  let jsdocOverSix = 0;
  const seen = new Set<number>();
  const markComments = (node: ts.Node): void => {
    if (node.getChildCount(sourceFile) > 0) {
      for (const child of node.getChildren(sourceFile)) markComments(child);
      return;
    }
    const fullStart = node.getFullStart();
    for (const range of [
      ...(ts.getTrailingCommentRanges(source, fullStart) ?? []),
      ...(ts.getLeadingCommentRanges(source, fullStart) ?? []),
    ]) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      commentMask.fill(1, range.pos, range.end);
      if (
        range.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
        source.startsWith("/**", range.pos)
      ) {
        const span = source.slice(range.pos, range.end).split("\n").length;
        if (span > 6) jsdocOverSix += 1;
      }
    }
  };
  markComments(sourceFile);
  return { commentMask, jsdocOverSix };
}

/** True when every non-whitespace character of the line sits inside comment trivia. */
function isCommentOnly(raw: string, offset: number, commentMask: Uint8Array): boolean {
  for (let column = 0; column < raw.length; column += 1) {
    if (!WHITESPACE.test(raw[column] as string) && commentMask[offset + column] === 0) {
      return false;
    }
  }
  return true;
}
async function scanAgentSources(
  root: string,
  pins: ResiduePins,
): Promise<Map<string, FileResidue>> {
  const notesByFile = new Map<string, Set<string>>();
  for (const entry of pins.durableByteNotes) {
    const set = notesByFile.get(entry.file) ?? new Set<string>();
    set.add(entry.marker);
    notesByFile.set(entry.file, set);
  }
  const results = new Map<string, FileResidue>();
  for await (const filePath of new Bun.Glob(AGENT_SRC_GLOB).scan({
    cwd: root,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    const source = await Bun.file(join(root, filePath)).text();
    results.set(filePath, classifyResidue(source, notesByFile.get(filePath)));
  }
  return results;
}

/** The one aggregation fold shared by the gate and `--measure`. */
function aggregateResidue(actuals: Map<string, FileResidue>): {
  readonly entries: readonly (readonly [string, FileResidue])[];
  readonly commentLines: number;
  readonly nonblankLines: number;
  readonly ratioBasisPoints: number;
  readonly jsdocOverSix: number;
} {
  const entries = [...actuals.entries()].sort();
  let commentLines = 0;
  let nonblankLines = 0;
  let jsdocOverSix = 0;
  for (const [, residue] of entries) {
    commentLines += residue.commentLines;
    nonblankLines += residue.nonblankLines;
    jsdocOverSix += residue.jsdocOverSix;
  }
  const ratioBasisPoints =
    nonblankLines === 0 ? 0 : Math.floor((commentLines / nonblankLines) * 10_000);
  return { entries, commentLines, nonblankLines, ratioBasisPoints, jsdocOverSix };
}

function compareCategory(
  file: string,
  category: "issue-number comment lines" | "divider lines",
  actual: number,
  pinned: number,
  violations: string[],
): void {
  if (actual > pinned) {
    violations.push(
      `VIOLATION [comment-residue] ${file}: ${category} ${actual} > pin ${pinned} — shrink only, never grow`,
    );
  } else if (actual < pinned) {
    violations.push(
      `VIOLATION [comment-residue] ${file}: pin exceeds actual ${category} (${pinned} > ${actual}): lower the pin`,
    );
  }
}

/** Fail-closed comparison: growth, slack, unpinned files, stale pins, stale notes, ceilings. */
export async function checkCommentResidue(
  root: string = ROOT,
  pins: ResiduePins = RESIDUE_PINS,
): Promise<string[]> {
  const violations: string[] = [];
  if (pins.durableByteNotes.length > DURABLE_BYTE_NOTE_BUDGET) {
    violations.push(
      `VIOLATION [comment-residue] durable-byte notes ${pins.durableByteNotes.length} > budget ${DURABLE_BYTE_NOTE_BUDGET}: retire notes instead of adding them`,
    );
  }
  const actuals = await scanAgentSources(root, pins);
  const totals = aggregateResidue(actuals);
  for (const [file, residue] of totals.entries) {
    const pinned = pins.files.get(file);
    if (pinned === undefined) {
      violations.push(
        `VIOLATION [comment-residue] ${file} is not pinned (issue lines ${residue.issueLines}, dividers ${residue.dividerLines}): add explicit pins`,
      );
      continue;
    }
    compareCategory(file, "issue-number comment lines", residue.issueLines, pinned[0], violations);
    compareCategory(file, "divider lines", residue.dividerLines, pinned[1], violations);
  }
  for (const [file] of [...pins.files.entries()].sort()) {
    if (!totals.entries.some(([actualFile]) => actualFile === file)) {
      violations.push(
        `VIOLATION [comment-residue] ${file} is pinned but absent: remove the stale pin`,
      );
    }
  }
  for (const note of pins.durableByteNotes) {
    if (!actuals.get(note.file)?.listedNotes.includes(note.marker)) {
      violations.push(
        `VIOLATION [comment-residue] ${note.file}: listed durable-byte note ${JSON.stringify(note.marker)} is absent: retire the entry`,
      );
    }
  }
  if (totals.ratioBasisPoints > pins.ratioBasisPoints) {
    violations.push(
      `VIOLATION [comment-residue] package comment ratio ${totals.ratioBasisPoints}bp > ceiling ${pins.ratioBasisPoints}bp — shrink only, never grow`,
    );
  }
  if (totals.jsdocOverSix > pins.jsdocOverSix) {
    violations.push(
      `VIOLATION [comment-residue] JSDoc blocks over six lines ${totals.jsdocOverSix} > ceiling ${pins.jsdocOverSix} — shrink only, never grow`,
    );
  } else if (totals.jsdocOverSix < pins.jsdocOverSix) {
    violations.push(
      `VIOLATION [comment-residue] JSDoc ceiling exceeds actual (${pins.jsdocOverSix} > ${totals.jsdocOverSix}): lower the ceiling`,
    );
  }
  return violations;
}

/** The current tree as a pin table, so a cleanup lowers pins in the same PR. */
async function measure(root: string, pins: ResiduePins): Promise<string> {
  const totals = aggregateResidue(await scanAgentSources(root, pins));
  const rows = totals.entries.map(
    ([file, residue]) => `  ["${file}", [${residue.issueLines}, ${residue.dividerLines}]],`,
  );
  return [
    ...rows,
    `// ratioBasisPoints: ${totals.ratioBasisPoints} (${totals.commentLines}/${totals.nonblankLines}), jsdocOverSix: ${totals.jsdocOverSix}`,
  ].join("\n");
}

/**
 * Durable-byte-contract allow-list (<= 10 entries, budget enforced by the
 * gate). An entry exempts exactly one comment-only line in exactly one file
 * from the unlisted issue-number count, never from the comment ratio. The
 * cleanup pass needed none: every persisted-byte note reads without a number.
 */
const DURABLE_BYTE_NOTES: readonly DurableByteNote[] = [];

/** Tight per-file actuals after the cleanup pass, explicit zeroes. */
const RESIDUE_FILE_PINS: ReadonlyMap<string, readonly [number, number]> = new Map([
  ["packages/agent/src/bundle.ts", [0, 0]],
  ["packages/agent/src/core/admission.ts", [0, 0]],
  ["packages/agent/src/core/alarm-ports.ts", [0, 0]],
  ["packages/agent/src/core/alarm.ts", [0, 0]],
  ["packages/agent/src/core/api.ts", [0, 0]],
  ["packages/agent/src/core/approval-policy.ts", [0, 0]],
  ["packages/agent/src/core/budget.ts", [0, 0]],
  ["packages/agent/src/core/bus.ts", [0, 0]],
  ["packages/agent/src/core/capability.ts", [0, 0]],
  ["packages/agent/src/core/commit.ts", [0, 0]],
  ["packages/agent/src/core/compaction-ports.ts", [0, 0]],
  ["packages/agent/src/core/compaction.ts", [0, 0]],
  ["packages/agent/src/core/compose.ts", [0, 0]],
  ["packages/agent/src/core/create.ts", [0, 0]],
  ["packages/agent/src/core/entity.ts", [0, 0]],
  ["packages/agent/src/core/failure.ts", [0, 0]],
  ["packages/agent/src/core/fork.ts", [0, 0]],
  ["packages/agent/src/core/gate/admit.ts", [0, 0]],
  ["packages/agent/src/core/gate/compile.ts", [0, 0]],
  ["packages/agent/src/core/gate/compose.ts", [0, 0]],
  ["packages/agent/src/core/gate/decide.ts", [0, 0]],
  ["packages/agent/src/core/gate/evaluate.ts", [0, 0]],
  ["packages/agent/src/core/gate/fold.ts", [0, 0]],
  ["packages/agent/src/core/gate/match.ts", [0, 0]],
  ["packages/agent/src/core/gate/migrate.ts", [0, 0]],
  ["packages/agent/src/core/gate/project.ts", [0, 0]],
  ["packages/agent/src/core/gate/registry.ts", [0, 0]],
  ["packages/agent/src/core/gate/row-parse.ts", [0, 0]],
  ["packages/agent/src/core/gate/rows.ts", [0, 0]],
  ["packages/agent/src/core/host.ts", [0, 0]],
  ["packages/agent/src/core/index.ts", [0, 0]],
  ["packages/agent/src/core/llm.ts", [0, 0]],
  ["packages/agent/src/core/message-factory.ts", [0, 0]],
  ["packages/agent/src/core/messages.ts", [0, 0]],
  ["packages/agent/src/core/metrics.ts", [0, 0]],
  ["packages/agent/src/core/model-select.ts", [0, 0]],
  ["packages/agent/src/core/points.ts", [0, 0]],
  ["packages/agent/src/core/ports.ts", [0, 0]],
  ["packages/agent/src/core/read.ts", [0, 0]],
  ["packages/agent/src/core/reason-codes.ts", [0, 0]],
  ["packages/agent/src/core/recovery.ts", [0, 0]],
  ["packages/agent/src/core/request-binding.ts", [0, 0]],
  ["packages/agent/src/core/request.ts", [0, 0]],
  ["packages/agent/src/core/retry.ts", [0, 0]],
  ["packages/agent/src/core/run-events.ts", [0, 0]],
  ["packages/agent/src/core/run.ts", [0, 0]],
  ["packages/agent/src/core/stop.ts", [0, 0]],
  ["packages/agent/src/core/store/action-hash.ts", [0, 0]],
  ["packages/agent/src/core/store/catalog.ts", [0, 0]],
  ["packages/agent/src/core/store/decision.ts", [0, 0]],
  ["packages/agent/src/core/store/errors.ts", [0, 0]],
  ["packages/agent/src/core/store/fence.ts", [0, 0]],
  ["packages/agent/src/core/store/handle.ts", [0, 0]],
  ["packages/agent/src/core/store/index.ts", [0, 0]],
  ["packages/agent/src/core/store/json.ts", [0, 0]],
  ["packages/agent/src/core/store/services.ts", [0, 0]],
  ["packages/agent/src/core/store/session-file/index.ts", [0, 0]],
  ["packages/agent/src/core/store/storage/sqlite-l0-observation.ts", [0, 0]],
  ["packages/agent/src/core/store/storage/sqlite-l0-policies.ts", [0, 0]],
  ["packages/agent/src/core/store/storage/sqlite-l0-rows.ts", [0, 0]],
  ["packages/agent/src/core/store/storage/sqlite-l0-sessions.ts", [0, 0]],
  ["packages/agent/src/core/store/storage/sqlite-l0-write.ts", [0, 0]],
  ["packages/agent/src/core/store/storage/timestamped-store.ts", [0, 0]],
  ["packages/agent/src/core/store/storage/write-effect.ts", [0, 0]],
  ["packages/agent/src/core/tool-output.ts", [0, 0]],
  ["packages/agent/src/core/tool.ts", [0, 0]],
  ["packages/agent/src/core/turn.ts", [0, 0]],
  ["packages/agent/src/core/types.ts", [0, 0]],
  ["packages/agent/src/index.ts", [0, 0]],
  ["packages/agent/src/inspect/history.ts", [0, 0]],
  ["packages/agent/src/inspect/index.ts", [0, 0]],
  ["packages/agent/src/inspect/tree.ts", [0, 0]],
  ["packages/agent/src/plugins/action/index.ts", [0, 0]],
  ["packages/agent/src/plugins/alarm/index.ts", [0, 0]],
  ["packages/agent/src/plugins/alarm/watch.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/candidate.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/compact.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/contract.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/cut.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/durable.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/estimate.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/execute-cut.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/geometry.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/index.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/measure.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/reduce.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/restore.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/speculate.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/successor.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/summary.ts", [0, 0]],
  ["packages/agent/src/plugins/hook/consultant.ts", [0, 0]],
  ["packages/agent/src/plugins/hook/index.ts", [0, 0]],
  ["packages/agent/src/plugins/hook/process.ts", [0, 0]],
  ["packages/agent/src/plugins/tool/dispatch.ts", [0, 0]],
  ["packages/agent/src/plugins/tool/index.ts", [0, 0]],
  ["packages/agent/src/testing/commit.ts", [0, 0]],
  ["packages/agent/src/testing/controller.ts", [0, 0]],
  ["packages/agent/src/testing/delivery.ts", [0, 0]],
  ["packages/agent/src/testing/index.ts", [0, 0]],
  ["packages/agent/src/testing/registry.ts", [0, 0]],
]);

export const RESIDUE_PINS: ResiduePins = {
  files: RESIDUE_FILE_PINS,
  // CEILING: measured after the 100-column rewrap; the package rule is 800bp.
  ratioBasisPoints: 710,
  jsdocOverSix: 0, // TIGHT: no JSDoc block may span more than six physical lines.
  durableByteNotes: DURABLE_BYTE_NOTES,
};

export async function main(
  argv: readonly string[] = Bun.argv,
  root: string = ROOT,
  io: {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
  } = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<void> {
  if (argv.includes("--measure")) {
    io.stdout(`${await measure(root, RESIDUE_PINS)}\n`);
    return;
  }
  const violations = await checkCommentResidue(root);
  for (const violation of violations) {
    io.stderr(`${violation}\n`);
  }
  if (violations.length > 0) {
    process.exitCode = 1;
    return;
  }
  io.stdout(
    `OK: comment residue pinned — ${RESIDUE_PINS.files.size} files, ratio ceiling ${RESIDUE_PINS.ratioBasisPoints}bp (growth-only), JSDoc>6 pin ${RESIDUE_PINS.jsdocOverSix} (tight), durable-byte notes ${RESIDUE_PINS.durableByteNotes.length}/${DURABLE_BYTE_NOTE_BUDGET}\n`,
  );
}

if (import.meta.main) await runScriptMain(main);
