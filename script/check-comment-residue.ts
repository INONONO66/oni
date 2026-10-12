import { join } from "node:path";
import ts from "typescript";
import { runScriptMain } from "./main-runner";

const ROOT = join(import.meta.dir, "..");
const AGENT_SRC_GLOB = "packages/agent/src/**/*.ts";

/**
 * #1343 comment-residue gate for packages/agent production sources: per-file,
 * shrink-only pins for issue-number comment lines and `// ───` dividers, plus
 * a package-wide comment-ratio CEILING and a tight JSDoc>6 pin. Per-file pins
 * are tight (pin === HEAD actual): growth fails AND slack fails, so cleanup
 * (#1344) lowers the matching pin in the same PR. `--measure` prints the
 * current tree as a pin table for exactly that purpose.
 */
export interface FileResidue {
  readonly issueLines: number;
  readonly dividerLines: number;
  readonly commentLines: number;
  readonly nonblankLines: number;
  readonly jsdocOverSix: number;
}

export interface ResiduePins {
  /** file -> [issue-number comment lines, divider lines], sorted, explicit zeroes. */
  readonly files: ReadonlyMap<string, readonly [number, number]>;
  /**
   * Package comment-to-nonblank ratio CEILING in basis points: only growth
   * fails. Slack passes, because adding plain code lowers the ratio and must
   * not fail the gate; #1344 lowers the ceiling deliberately.
   */
  readonly ratioBasisPoints: number;
  /**
   * Package count of JSDoc blocks spanning more than six lines. TIGHT pin:
   * growth AND slack fail, because this count only moves when a JSDoc block
   * is edited, never when plain code is added.
   */
  readonly jsdocOverSix: number;
  /** Exact structural-header exemptions: the marker line is not a divider hit. */
  readonly structuralHeaders: readonly { readonly file: string; readonly marker: string }[];
}

/** Hard budget for structural-header exemptions, enforced by the gate itself. */
const STRUCTURAL_HEADER_BUDGET = 10;

const ISSUE_TOKEN = /#\d{3,4}/;
const DIVIDER = /^\/\/ ───/;
const WHITESPACE = /\s/;

/**
 * Comment lines come from TypeScript comment-trivia ranges, not line-prefix
 * heuristics: the file is parsed with `ts.createSourceFile` (so template
 * literals and regexes lex correctly) and every token's leading and trailing
 * trivia yield its `SingleLineCommentTrivia`/`MultiLineCommentTrivia` ranges. A nonblank
 * line is a comment line only when every one of its non-whitespace characters
 * sits inside comment trivia: trailing comments on code lines are code, the
 * continuation lines of a block opened after code are comments, and
 * template-literal text that looks like `//` is code. The JSDoc>6 count
 * derives from MultiLineCommentTrivia ranges whose text starts with `/**` and
 * spans more than six physical lines.
 */
export function classifyResidue(
  source: string,
  exemptMarkers: ReadonlySet<string> = new Set(),
): FileResidue {
  const { commentMask, jsdocOverSix } = commentTrivia(source);
  const tally = { issueLines: 0, dividerLines: 0, commentLines: 0, nonblankLines: 0, jsdocOverSix };
  let offset = 0;
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      tally.nonblankLines += 1;
      if (isCommentOnly(raw, offset, commentMask)) {
        tally.commentLines += 1;
        if (ISSUE_TOKEN.test(trimmed)) tally.issueLines += 1;
        if (DIVIDER.test(raw) && !exemptMarkers.has(trimmed)) tally.dividerLines += 1;
      }
    }
    offset += raw.length + 1;
  }
  return tally;
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
  const markersByFile = new Map<string, Set<string>>();
  for (const entry of pins.structuralHeaders) {
    const set = markersByFile.get(entry.file) ?? new Set<string>();
    set.add(entry.marker);
    markersByFile.set(entry.file, set);
  }
  const results = new Map<string, FileResidue>();
  for await (const filePath of new Bun.Glob(AGENT_SRC_GLOB).scan({
    cwd: root,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    const source = await Bun.file(join(root, filePath)).text();
    results.set(filePath, classifyResidue(source, markersByFile.get(filePath)));
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

/** Fail-closed comparison: growth, slack, unpinned files, stale pins, ceilings. */
export async function checkCommentResidue(
  root: string = ROOT,
  pins: ResiduePins = RESIDUE_PINS,
): Promise<string[]> {
  const violations: string[] = [];
  if (pins.structuralHeaders.length > STRUCTURAL_HEADER_BUDGET) {
    violations.push(
      `VIOLATION [comment-residue] structural-header exemptions ${pins.structuralHeaders.length} > budget ${STRUCTURAL_HEADER_BUDGET}: retire exemptions instead of adding them`,
    );
  }
  const totals = aggregateResidue(await scanAgentSources(root, pins));
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
 * Structural-header allow-list (<=10 exact entries, budget enforced by the
 * gate). An entry exempts exactly one marker line from the divider count in
 * exactly one file; it never exempts issue-number residue — the `#1305` token
 * on the exempted line below still counts against the file's issue-line pin.
 */
const STRUCTURAL_HEADERS: readonly { readonly file: string; readonly marker: string }[] = [
  {
    // The inspect barrel's read-back section header is a navigation aid for a
    // 500+ line module, kept until #1344 splits the file.
    file: "packages/agent/src/inspect/index.ts",
    marker: "// ─── #1305: stored tool output read-back ───",
  },
];

/**
 * #1343 baseline pins measured at d9800ad74 (identical under packages/agent
 * to the issue's pin 2321f1aff): tight per-file actuals, explicit zeroes.
 */
const RESIDUE_FILE_PINS: ReadonlyMap<string, readonly [number, number]> = new Map([
  ["packages/agent/src/bundle.ts", [6, 0]],
  ["packages/agent/src/core/admission.ts", [10, 0]],
  ["packages/agent/src/core/alarm-ports.ts", [2, 0]],
  ["packages/agent/src/core/alarm.ts", [16, 1]],
  ["packages/agent/src/core/api.ts", [7, 0]],
  ["packages/agent/src/core/approval-policy.ts", [1, 0]],
  ["packages/agent/src/core/budget.ts", [1, 0]],
  ["packages/agent/src/core/bus.ts", [8, 0]],
  ["packages/agent/src/core/capability.ts", [6, 0]],
  ["packages/agent/src/core/commit.ts", [16, 2]],
  ["packages/agent/src/core/compaction-ports.ts", [2, 0]],
  ["packages/agent/src/core/compaction.ts", [1, 0]],
  ["packages/agent/src/core/compose.ts", [10, 0]],
  ["packages/agent/src/core/create.ts", [0, 0]],
  ["packages/agent/src/core/entity.ts", [37, 3]],
  ["packages/agent/src/core/failure.ts", [4, 2]],
  ["packages/agent/src/core/fork.ts", [9, 0]],
  ["packages/agent/src/core/gate/admit.ts", [3, 0]],
  ["packages/agent/src/core/gate/compile.ts", [5, 0]],
  ["packages/agent/src/core/gate/compose.ts", [7, 0]],
  ["packages/agent/src/core/gate/decide.ts", [25, 10]],
  ["packages/agent/src/core/gate/evaluate.ts", [6, 0]],
  ["packages/agent/src/core/gate/fold.ts", [7, 0]],
  ["packages/agent/src/core/gate/match.ts", [0, 0]],
  ["packages/agent/src/core/gate/migrate.ts", [4, 0]],
  ["packages/agent/src/core/gate/project.ts", [3, 1]],
  ["packages/agent/src/core/gate/registry.ts", [4, 0]],
  ["packages/agent/src/core/gate/row-parse.ts", [4, 0]],
  ["packages/agent/src/core/gate/rows.ts", [1, 0]],
  ["packages/agent/src/core/host.ts", [0, 0]],
  ["packages/agent/src/core/index.ts", [3, 1]],
  ["packages/agent/src/core/message-factory.ts", [0, 0]],
  ["packages/agent/src/core/messages.ts", [11, 1]],
  ["packages/agent/src/core/metrics.ts", [1, 0]],
  ["packages/agent/src/core/points.ts", [2, 0]],
  ["packages/agent/src/core/ports.ts", [5, 4]],
  ["packages/agent/src/core/read.ts", [1, 0]],
  ["packages/agent/src/core/reason-codes.ts", [0, 0]],
  ["packages/agent/src/core/recovery.ts", [3, 0]],
  ["packages/agent/src/core/request-binding.ts", [0, 0]],
  ["packages/agent/src/core/request.ts", [4, 2]],
  ["packages/agent/src/core/retry.ts", [0, 0]],
  ["packages/agent/src/core/run-events.ts", [4, 1]],
  ["packages/agent/src/core/run.ts", [40, 9]],
  ["packages/agent/src/core/stop.ts", [1, 1]],
  ["packages/agent/src/core/store/action-hash.ts", [1, 0]],
  ["packages/agent/src/core/store/catalog.ts", [15, 0]],
  ["packages/agent/src/core/store/decision.ts", [0, 0]],
  ["packages/agent/src/core/store/errors.ts", [2, 0]],
  ["packages/agent/src/core/store/fence.ts", [17, 0]],
  ["packages/agent/src/core/store/handle.ts", [0, 0]],
  ["packages/agent/src/core/store/index.ts", [1, 0]],
  ["packages/agent/src/core/store/json.ts", [0, 0]],
  ["packages/agent/src/core/store/services.ts", [0, 0]],
  ["packages/agent/src/core/store/session-file/index.ts", [20, 2]],
  ["packages/agent/src/core/store/storage/sqlite-l0-observation.ts", [0, 0]],
  ["packages/agent/src/core/store/storage/sqlite-l0-policies.ts", [0, 0]],
  ["packages/agent/src/core/store/storage/sqlite-l0-rows.ts", [2, 0]],
  ["packages/agent/src/core/store/storage/sqlite-l0-sessions.ts", [0, 0]],
  ["packages/agent/src/core/store/storage/sqlite-l0-write.ts", [8, 1]],
  ["packages/agent/src/core/store/storage/timestamped-store.ts", [0, 0]],
  ["packages/agent/src/core/store/storage/write-effect.ts", [0, 0]],
  ["packages/agent/src/core/tool-output.ts", [2, 0]],
  ["packages/agent/src/core/tool.ts", [7, 4]],
  ["packages/agent/src/core/turn.ts", [17, 5]],
  ["packages/agent/src/core/types.ts", [10, 0]],
  ["packages/agent/src/index.ts", [1, 1]],
  ["packages/agent/src/inspect/history.ts", [0, 0]],
  ["packages/agent/src/inspect/index.ts", [5, 0]],
  ["packages/agent/src/inspect/tree.ts", [2, 0]],
  ["packages/agent/src/model/auth/index.ts", [0, 0]],
  ["packages/agent/src/model/auth/storage.ts", [2, 0]],
  ["packages/agent/src/model/error.ts", [0, 0]],
  ["packages/agent/src/model/errors.ts", [2, 0]],
  ["packages/agent/src/model/index.ts", [0, 0]],
  ["packages/agent/src/model/layers.ts", [1, 0]],
  ["packages/agent/src/model/message/index.ts", [1, 0]],
  ["packages/agent/src/model/model/index.ts", [0, 0]],
  ["packages/agent/src/model/model/loader.ts", [4, 0]],
  ["packages/agent/src/model/model/schema.ts", [1, 0]],
  ["packages/agent/src/model/model/select.ts", [0, 0]],
  ["packages/agent/src/model/processor/event-schema.ts", [0, 0]],
  ["packages/agent/src/model/processor/index.ts", [2, 0]],
  ["packages/agent/src/model/processor/normalize.ts", [0, 0]],
  ["packages/agent/src/model/processor/stream-events.ts", [9, 0]],
  ["packages/agent/src/model/processor/tool-events.ts", [3, 0]],
  ["packages/agent/src/model/provider/identity.ts", [0, 0]],
  ["packages/agent/src/model/provider/index.ts", [2, 0]],
  ["packages/agent/src/model/provider/proxy-models.ts", [0, 0]],
  ["packages/agent/src/model/provider/sdk.ts", [0, 0]],
  ["packages/agent/src/model/provider/stream.ts", [0, 0]],
  ["packages/agent/src/model/provider/transform.ts", [1, 0]],
  ["packages/agent/src/model/retry/delay.ts", [1, 0]],
  ["packages/agent/src/model/retry/index.ts", [1, 0]],
  ["packages/agent/src/model/retry/telemetry.ts", [1, 0]],
  ["packages/agent/src/model/run.ts", [6, 0]],
  ["packages/agent/src/model/services.ts", [1, 0]],
  ["packages/agent/src/model/sink.ts", [2, 0]],
  ["packages/agent/src/model/token/index.ts", [0, 0]],
  ["packages/agent/src/model/token/schema.ts", [0, 0]],
  ["packages/agent/src/plugins/action/index.ts", [2, 0]],
  ["packages/agent/src/plugins/alarm/index.ts", [5, 0]],
  ["packages/agent/src/plugins/alarm/watch.ts", [8, 0]],
  ["packages/agent/src/plugins/compaction/candidate.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/compact.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/contract.ts", [1, 0]],
  ["packages/agent/src/plugins/compaction/cut.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/durable.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/estimate.ts", [2, 0]],
  ["packages/agent/src/plugins/compaction/execute-cut.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/geometry.ts", [1, 0]],
  ["packages/agent/src/plugins/compaction/index.ts", [2, 0]],
  ["packages/agent/src/plugins/compaction/measure.ts", [1, 0]],
  ["packages/agent/src/plugins/compaction/reduce.ts", [0, 0]],
  ["packages/agent/src/plugins/compaction/restore.ts", [1, 0]],
  ["packages/agent/src/plugins/compaction/speculate.ts", [1, 0]],
  ["packages/agent/src/plugins/compaction/successor.ts", [1, 0]],
  ["packages/agent/src/plugins/compaction/summary.ts", [7, 0]],
  ["packages/agent/src/plugins/hook/consultant.ts", [4, 0]],
  ["packages/agent/src/plugins/hook/index.ts", [3, 0]],
  ["packages/agent/src/plugins/hook/process.ts", [11, 0]],
  ["packages/agent/src/plugins/tool/dispatch.ts", [4, 0]],
  ["packages/agent/src/plugins/tool/index.ts", [1, 0]],
  ["packages/agent/src/testing/commit.ts", [0, 0]],
  ["packages/agent/src/testing/controller.ts", [1, 0]],
  ["packages/agent/src/testing/index.ts", [1, 0]],
  ["packages/agent/src/testing/registry.ts", [2, 1]],
]);

export const RESIDUE_PINS: ResiduePins = {
  files: RESIDUE_FILE_PINS,
  ratioBasisPoints: 1_424, // CEILING: re-measured after the #1344 cleanup (1425 = 3485/24454 at d9800ad74)
  // TIGHT: JSDoc blocks spanning >6 physical lines at d9800ad74. The issue's
  // 97 is not reproducible under any line-span definition; ceiling = measured
  // 126 under "spans > 6 physical lines".
  jsdocOverSix: 126,
  structuralHeaders: STRUCTURAL_HEADERS,
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
    `OK: comment residue pinned — ${RESIDUE_PINS.files.size} files, ratio ceiling ${RESIDUE_PINS.ratioBasisPoints}bp (growth-only), JSDoc>6 pin ${RESIDUE_PINS.jsdocOverSix} (tight)\n`,
  );
}

if (import.meta.main) await runScriptMain(main);
