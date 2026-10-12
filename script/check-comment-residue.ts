import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// JSDoc length spans the /** opener through the */ closer, inclusive.
// A block exceeds six lines when that inclusive span is greater than six.

const ROOT = join(import.meta.dir, "..");
const PIN_PATH = join(import.meta.dir, "conformance/comment-residue-pins.json");

export interface ResiduePin {
  issues: number;
  dividers: number;
}
export interface ResidueBaseline {
  files: Record<string, ResiduePin>;
  commentLines: number;
  nonblankLines: number;
  longJsdoc: number;
}
export interface ResidueActual extends ResiduePin {
  commentLines: number;
  nonblankLines: number;
  longJsdoc: number;
}

// These exact, navigational section markers are structural, rather than
// migration dividers. Only the divider count is exempt: #1305 still counts.
const STRUCTURAL_HEADERS: Readonly<Record<string, readonly string[]>> = {
  "packages/agent/src/inspect/index.ts": ["// ─── #1305: stored tool output read-back ───"],
};

/** Count syntax-level comments, never issue numbers inside strings or code. */
function countedDivider(path: string, line: string, row: number, first: number): boolean {
  return row === first && /^\/\/ ───/.test(line.trimStart()) &&
    !STRUCTURAL_HEADERS[path]?.includes(line.trim());
}

export function classifyResidue(path: string, text: string): ResidueActual {
  const lines = text.split(/\r?\n/);
  const issues = new Set<number>();
  const dividers = new Set<number>();
  let longJsdoc = 0;
  const ranges = commentRanges(path, text);
  const commentRows = commentOnlyRows(text, ranges);
  const starts = [0, ...[...text.matchAll(/\n/g)].map((match) => match.index + 1)];
  for (const { pos: start, end } of ranges) {
    const first = text.slice(0, start).split("\n").length - 1;
    const last = text.slice(0, end - 1).split("\n").length - 1;
    if (text.slice(start, end).startsWith("/**") && last - first + 1 > 6) longJsdoc++;
    for (let row = first; row <= last; row++) {
      const line = lines[row] ?? "";

      if (!commentRows.has(row)) continue;
      const lineStart = starts[row] ?? 0;
      const segment = text.slice(Math.max(start, lineStart), Math.min(end, lineStart + line.length));
      if (/#\d{3,4}(?!\d)/.test(segment)) issues.add(row);
      if (countedDivider(path, line, row, first)) dividers.add(row);
    }
  }
  return {
    issues: issues.size,
    dividers: dividers.size,
    commentLines: commentRows.size,
    nonblankLines: lines.filter((line) => line.trim() !== "").length,
    longJsdoc,
  };
}

// A ratio line is nonblank and consists entirely of syntax comments and
// whitespace; mixed executable/comment lines remain executable lines.
function commentOnlyRows(text: string, ranges: readonly ts.CommentRange[]): ReadonlySet<number> {
  const code = text.split("");
  const touched = new Set<number>();
  for (const range of ranges) {
    const first = text.slice(0, range.pos).split("\n").length - 1;
    const last = text.slice(0, range.end - 1).split("\n").length - 1;
    for (let row = first; row <= last; row++) touched.add(row);
    for (let position = range.pos; position < range.end; position++) {
      if (code[position] !== "\n") code[position] = " ";
    }
  }
  const remaining = code.join("").split(/\r?\n/);
  const lines = text.split(/\r?\n/);
  return new Set([...touched].filter((row) => lines[row]?.trim() !== "" && remaining[row]?.trim() === ""));
}

function commentRanges(path: string, text: string): readonly ts.CommentRange[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const ranges = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node): void => {
    for (const position of [node.pos, node.end]) {
      for (const range of [...(ts.getLeadingCommentRanges(text, position) ?? []), ...(ts.getTrailingCommentRanges(text, position) ?? [])]) {
        ranges.set(range.pos, range);
      }
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...ranges.values()].sort((a, b) => a.pos - b.pos);
}

export function measureResidue(files: Readonly<Record<string, string>>): { files: Record<string, ResidueActual>; commentLines: number; nonblankLines: number; longJsdoc: number } {
  const actual: Record<string, ResidueActual> = {};
  let commentLines = 0;
  let nonblankLines = 0;
  let longJsdoc = 0;
  for (const path of Object.keys(files).sort()) {
    const result = classifyResidue(path, files[path] ?? "");
    actual[path] = result;
    commentLines += result.commentLines;
    nonblankLines += result.nonblankLines;
    longJsdoc += result.longJsdoc;
  }
  return { files: actual, commentLines, nonblankLines, longJsdoc };
}

/** Exact per-file pins: both growth and unrecorded cleanup fail closed. */
export function residueViolations(files: Readonly<Record<string, string>>, baseline: ResidueBaseline): string[] {
  const actual = measureResidue(files);
  const violations: string[] = [];
  for (const path of Object.keys(actual.files).sort()) {
    const count = actual.files[path];
    const pin = baseline.files[path];
    if (!pin) {
      violations.push(`${path}: unpinned source file`);
      continue;
    }
    if (!count) continue;
    for (const key of ["issues", "dividers"] as const) {
      if (count[key] !== pin[key]) violations.push(`${path}: ${key} actual ${count[key]}, pin ${pin[key]} (${count[key] > pin[key] ? "growth" : "stale pin"})`);
    }
  }
  for (const path of Object.keys(baseline.files).sort()) {
    if (!(path in actual.files)) violations.push(`${path}: pin has no source file`);
  }
  // Cross-multiply to avoid a rounded percentage admitting growth.
  if (actual.commentLines * baseline.nonblankLines > baseline.commentLines * actual.nonblankLines) {
    violations.push(`comment ratio actual ${actual.commentLines}/${actual.nonblankLines}, ceiling ${baseline.commentLines}/${baseline.nonblankLines}`);
  }
  if (actual.longJsdoc > baseline.longJsdoc) violations.push(`long JSDoc blocks actual ${actual.longJsdoc}, ceiling ${baseline.longJsdoc}`);
  return violations;
}

export function trackedAgentFiles(root = ROOT): Record<string, string> {
  const paths = execFileSync("git", ["ls-files", "-z", "--", "packages/agent/src"], { cwd: root })
    .toString().split("\0").filter((path) => path.endsWith(".ts") && !/\.(?:test|spec)\.ts$/.test(path) && !/\/(?:test|tests|__tests__)\//.test(path));
  return Object.fromEntries(paths.sort().map((path) => [path, readFileSync(join(root, path), "utf8")]));
}

export function baselineFor(files: Readonly<Record<string, string>>): ResidueBaseline {
  const actual = measureResidue(files);
  return {
    files: Object.fromEntries(Object.entries(actual.files).map(([path, count]) => [path, { issues: count.issues, dividers: count.dividers }])),
    commentLines: actual.commentLines,
    nonblankLines: actual.nonblankLines,
    longJsdoc: actual.longJsdoc,
  };
}

/** Regenerate only after cleanup; an accidental increase cannot be blessed. */
export function updateResidueBaseline(files: Readonly<Record<string, string>>, previous: ResidueBaseline): ResidueBaseline {
  const next = baselineFor(files);
  for (const [path, count] of Object.entries(next.files)) {
    const old = previous.files[path] ?? { issues: 0, dividers: 0 };
    for (const key of ["issues", "dividers"] as const) {
      if (count[key] > old[key]) throw new Error(`UPDATE_REFUSED: ${path} ${key} ${count[key]} > ${old[key]}`);
    }
  }
  if (next.commentLines > previous.commentLines ||
      next.commentLines * previous.nonblankLines > previous.commentLines * next.nonblankLines) {
    throw new Error(`UPDATE_REFUSED: comment ratio ${next.commentLines}/${next.nonblankLines} exceeds ${previous.commentLines}/${previous.nonblankLines}`);
  }
  if (next.longJsdoc > previous.longJsdoc) throw new Error(`UPDATE_REFUSED: long JSDoc ${next.longJsdoc} > ${previous.longJsdoc}`);
  return next;
}

if (import.meta.main) {
  const files = trackedAgentFiles();
  const previous = JSON.parse(readFileSync(PIN_PATH, "utf8")) as ResidueBaseline;
  if (process.argv.slice(2).includes("--update")) {
    const baseline = updateResidueBaseline(files, previous);
    writeFileSync(PIN_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Updated ${PIN_PATH}: ${Object.keys(baseline.files).length} files`);
  } else {
    const baseline = previous;
    const violations = residueViolations(files, baseline);
    for (const violation of violations) console.error(`VIOLATION: ${violation}`);
    if (violations.length > 0) process.exitCode = 1;
    else console.log(`OK: comment residue pinned in ${Object.keys(baseline.files).length} files; ratio ${baseline.commentLines}/${baseline.nonblankLines}; long JSDoc ${baseline.longJsdoc}`);
  }
}
