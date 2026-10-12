import { join } from "node:path";
import { runScriptMain } from "./main-runner";

const ROOT = join(import.meta.dir, "..");
const AGENT_SRC_GLOB = "packages/agent/src/**/*.ts";

/**
 * #1343 comment-residue gate for packages/agent production sources: per-file,
 * shrink-only pins for issue-number comment lines and `// ───` dividers, plus
 * package-wide ceilings for the comment ratio and over-six-line JSDoc blocks.
 * Every pin is tight (pin === HEAD actual): growth fails AND slack fails, so
 * cleanup (#1344) lowers the matching pin in the same PR. `--measure` prints
 * the current tree as a pin table for exactly that purpose.
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
  /** Package comment-to-nonblank ratio ceiling in basis points (floor). */
  readonly ratioBasisPoints: number;
  /** Package count of JSDoc blocks spanning more than six lines. */
  readonly jsdocOverSix: number;
  /** Exact structural-header exemptions: the marker line is not a divider hit. */
  readonly structuralHeaders: readonly { readonly file: string; readonly marker: string }[];
}

const ISSUE_TOKEN = /#\d{3,4}/;
const DIVIDER = /^\/\/ ───/;

/**
 * Deterministic line classifier: a line counts as a comment line only when it
 * is comment-only: slash-slash lines, and every line of a block comment with
 * no code before the opener or after the closer. Trailing comments on code
 * lines are code.
 */
export function classifyResidue(
  source: string,
  exemptMarkers: ReadonlySet<string> = new Set(),
): FileResidue {
  const tally = {
    issueLines: 0,
    dividerLines: 0,
    commentLines: 0,
    nonblankLines: 0,
    jsdocOverSix: 0,
  };
  const block = { open: false, jsdoc: false, start: 0 };
  for (const [index, raw] of source.split("\n").entries()) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) tally.nonblankLines += 1;
    const comment = block.open
      ? blockContinuation(trimmed, index, block, tally)
      : lineStart(raw, trimmed, index, block, tally, exemptMarkers);
    if (comment) {
      tally.commentLines += 1;
      if (ISSUE_TOKEN.test(trimmed)) tally.issueLines += 1;
    }
  }
  return tally;
}

type BlockState = { open: boolean; jsdoc: boolean; start: number };
type Tally = { jsdocOverSix: number; dividerLines: number };

/** Inside a block comment: the line is a comment unless code follows the closer. */
function blockContinuation(
  trimmed: string,
  index: number,
  block: BlockState,
  tally: Tally,
): boolean {
  const close = trimmed.indexOf("*/");
  if (close === -1) return true;
  if (block.jsdoc && index - block.start + 1 > 6) tally.jsdocOverSix += 1;
  block.open = false;
  return trimmed.slice(close + 2).trim().length === 0;
}

/** Outside a block comment: slash-slash lines and block openers are comments. */
function lineStart(
  raw: string,
  trimmed: string,
  index: number,
  block: BlockState,
  tally: Tally,
  exemptMarkers: ReadonlySet<string>,
): boolean {
  if (trimmed.startsWith("//")) {
    if (DIVIDER.test(raw) && !exemptMarkers.has(trimmed)) tally.dividerLines += 1;
    return true;
  }
  if (!trimmed.startsWith("/*")) return false;
  block.jsdoc = trimmed.startsWith("/**");
  block.start = index;
  const close = trimmed.indexOf("*/", 2);
  if (close === -1) {
    block.open = true;
    return true;
  }
  return trimmed.slice(close + 2).trim().length === 0;
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
  const actuals = await scanAgentSources(root, pins);
  let commentLines = 0;
  let nonblankLines = 0;
  let jsdocOverSix = 0;
  for (const [file, residue] of [...actuals.entries()].sort()) {
    commentLines += residue.commentLines;
    nonblankLines += residue.nonblankLines;
    jsdocOverSix += residue.jsdocOverSix;
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
    if (!actuals.has(file)) {
      violations.push(
        `VIOLATION [comment-residue] ${file} is pinned but absent: remove the stale pin`,
      );
    }
  }
  const ratioBasisPoints =
    nonblankLines === 0 ? 0 : Math.floor((commentLines / nonblankLines) * 10_000);
  if (ratioBasisPoints > pins.ratioBasisPoints) {
    violations.push(
      `VIOLATION [comment-residue] package comment ratio ${ratioBasisPoints}bp > ceiling ${pins.ratioBasisPoints}bp — shrink only, never grow`,
    );
  } else if (ratioBasisPoints < pins.ratioBasisPoints) {
    violations.push(
      `VIOLATION [comment-residue] comment-ratio ceiling exceeds actual (${pins.ratioBasisPoints}bp > ${ratioBasisPoints}bp): lower the ceiling`,
    );
  }
  if (jsdocOverSix > pins.jsdocOverSix) {
    violations.push(
      `VIOLATION [comment-residue] JSDoc blocks over six lines ${jsdocOverSix} > ceiling ${pins.jsdocOverSix} — shrink only, never grow`,
    );
  } else if (jsdocOverSix < pins.jsdocOverSix) {
    violations.push(
      `VIOLATION [comment-residue] JSDoc ceiling exceeds actual (${pins.jsdocOverSix} > ${jsdocOverSix}): lower the ceiling`,
    );
  }
  return violations;
}

async function measure(root: string): Promise<string> {
  const actuals = await scanAgentSources(root, RESIDUE_PINS);
  let commentLines = 0;
  let nonblankLines = 0;
  let jsdocOverSix = 0;
  const rows: string[] = [];
  for (const [file, residue] of [...actuals.entries()].sort()) {
    commentLines += residue.commentLines;
    nonblankLines += residue.nonblankLines;
    jsdocOverSix += residue.jsdocOverSix;
    rows.push(`  ["${file}", [${residue.issueLines}, ${residue.dividerLines}]],`);
  }
  const ratio = nonblankLines === 0 ? 0 : Math.floor((commentLines / nonblankLines) * 10_000);
  return [
    ...rows,
    `// ratioBasisPoints: ${ratio} (${commentLines}/${nonblankLines}), jsdocOverSix: ${jsdocOverSix}`,
  ].join("\n");
}

/**
 * Structural-header allow-list (<=10 exact entries, documented). An entry
 * exempts exactly one marker line from the divider count in exactly one file;
 * it never exempts issue-number residue — the `#1305` token on the exempted
 * line below still counts against the file's issue-line pin.
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
  ["packages/agent/src/core/gate/project.ts", [4, 1]],
  ["packages/agent/src/core/gate/registry.ts", [4, 0]],
  ["packages/agent/src/core/gate/row-parse.ts", [4, 0]],
  ["packages/agent/src/core/gate/rows.ts", [1, 0]],
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
  ["packages/agent/src/core/store/fence.ts", [18, 0]],
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
  ratioBasisPoints: 1_425, // 3485 comment / 24454 nonblank lines at d9800ad74
  jsdocOverSix: 126, // JSDoc blocks spanning >6 lines at d9800ad74
  structuralHeaders: STRUCTURAL_HEADERS,
};

async function main(): Promise<void> {
  if (Bun.argv.includes("--measure")) {
    process.stdout.write(`${await measure(ROOT)}\n`);
    return;
  }
  const violations = await checkCommentResidue();
  for (const violation of violations) {
    process.stderr.write(`${violation}\n`);
  }
  if (violations.length > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `OK: comment residue pinned — ${RESIDUE_PINS.files.size} files, ratio ceiling ${RESIDUE_PINS.ratioBasisPoints}bp, JSDoc>6 ceiling ${RESIDUE_PINS.jsdocOverSix}\n`,
  );
}

if (import.meta.main) await runScriptMain(main);
