/**
 * Patch coverage gate (#1116): every changed executable line must be covered.
 *
 * Inputs are one or more lcov files (glob) plus a base ref. Changed and added
 * lines in packages/-/src and apps/-/src TS/JS modules and top-level
 * script *.ts files (non-test) come from `git diff --unified=0 <base>...HEAD`. A changed line is
 * uncovered when every lcov reporting the file records it with zero hits.
 * An independent TypeScript AST filter removes syntactically non-executable
 * lines, even when Bun records zero hits for them in every lane. Lines absent
 * from the lcov intersection never count. AST skips are counted per file.
 * A gated file with NO `SF:` record in any lcov was never loaded by any test:
 * it fails outright (`<path>: no coverage record`) unless transpilation proves
 * the file has zero executable lines (type-only modules; `.d.ts` is excluded
 * from gating). Each lcov's repo prefix is inferred from its path: the segment
 * starting at `packages/`, `apps/` or `script` before the `coverage/`
 * directory.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import ts from "typescript";

// Only modules the transpiler can read are gated; stylesheets and other
// assets under src/ carry no executable lines. Nested script directories are
// production tooling (#1318): `script/quality-ci-input.ts` imports
// `script/quality-metrics/input.ts`, so those trees are gated too. Fixture
// trees under `script/fixtures/` are test inputs, never tooling.
const GATED = /^(?:(?:packages|apps)\/[^/]+\/src\/.+\.[cm]?[jt]sx?|script\/(?:[^/]+|quality-metrics\/[^/]+|quality-mutation\/[^/]+)\.ts)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$|\.d\.ts$/;
const SCRIPT_FIXTURE = /^script\/fixtures\//;

export function gatedPath(path: string): boolean {
  return GATED.test(path) && !TEST_FILE.test(path) && !SCRIPT_FIXTURE.test(path);
}

/** repo prefix of an lcov file: `.../<packages/x|apps/x|script>/coverage/...` */
export function lcovPrefix(lcovPath: string): string {
  const segments = dirname(resolve(lcovPath)).split(sep);
  const coverage = segments.lastIndexOf("coverage");
  const owner = coverage === -1 ? segments : segments.slice(0, coverage);
  for (let index = owner.length - 1; index >= 0; index -= 1) {
    if (owner[index] === "packages" || owner[index] === "apps") {
      return owner.slice(index, index + 2).join("/");
    }
  }
  return owner.at(-1) === "script" ? "script" : "";
}

function recordHit(rows: Map<number, number>, record: string): void {
  const [lineNumber, hits] = record.split(",").map(Number);
  if (lineNumber === undefined || hits === undefined || Number.isNaN(lineNumber)) return;
  rows.set(lineNumber, Math.max(rows.get(lineNumber) ?? 0, hits));
}

type Merged = { hits: Map<number, number>; reports: number; seen: Map<number, number> };

function mergeLcov(union: Map<string, Merged>, file: string, root: string): void {
  const prefix = lcovPrefix(file);
  if (prefix === "") throw new Error(`lcov without workspace ancestor (flattened artifact?): ${file}`);
  let entry: Merged | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("SF:")) {
      const raw = line.slice(3).trim();
      // A lane that loads another workspace's module records it relative to
      // its own root (`SF:../../packages/agent/src/x.ts` from apps/oni);
      // normalize so it merges with that workspace's own lane record.
      const source = isAbsolute(raw) ? relative(root, raw) : posix.normalize(`${prefix}/${raw}`);
      entry = union.get(source) ?? { hits: new Map(), reports: 0, seen: new Map() };
      entry.reports += 1;
      union.set(source, entry);
      continue;
    }
    if (!line.startsWith("DA:") || entry === undefined) continue;
    const lineNumber = Number(line.slice(3).split(",")[0]);
    if (!Number.isNaN(lineNumber)) entry.seen.set(lineNumber, (entry.seen.get(lineNumber) ?? 0) + 1);
    recordHit(entry.hits, line.slice(3));
  }
}

/**
 * Union of DA records across lcov files: repo path -> line -> max hits.
 *
 * A lane that never executed a function reports every line in its range as
 * `DA:n,0`, braces and comments included, while a lane that did execute it
 * reports only the executable lines. A line is therefore an uncovered claim
 * only when every lcov reporting the file records it; a line one reporting
 * lane treats as non-executable is dropped instead of surfacing as a false
 * zero.
 */
export function lcovUnion(
  files: readonly string[],
  root: string,
): Map<string, Map<number, number>> {
  const merged = new Map<string, Merged>();
  for (const file of files) mergeLcov(merged, file, root);
  const union = new Map<string, Map<number, number>>();
  for (const [source, entry] of merged) {
    for (const [lineNumber, count] of entry.seen) {
      if (count < entry.reports) entry.hits.delete(lineNumber);
    }
    union.set(source, entry.hits);
  }
  return union;
}

/** Changed/added line numbers per gated repo path from a unified-0 diff. */
export function changedLines(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  let path = "";
  for (const line of diff.split("\n")) {
    const file = /^\+\+\+ b\/(.+)$/.exec(line);
    if (file?.[1] !== undefined) {
      path = gatedPath(file[1]) ? file[1] : "";
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk?.[1] === undefined || path === "") continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const rows = changed.get(path) ?? new Set<number>();
    changed.set(path, rows);
    for (let row = start; row < start + count; row += 1) rows.add(row);
  }
  return changed;
}

/** True when the type-stripped emit of a module still contains code. */
export function hasExecutableCode(source: string, path: string): boolean {
  const transpiled = new Bun.Transpiler({
    loader: path.endsWith(".tsx") ? "tsx" : "ts",
  }).transformSync(source);
  return transpiled.split("\n").some((line: string) => line.trim() !== "");
}

function typeOnlySyntax(node: ts.Node): boolean {
  // TypeScript also calls runtime class heritage a TypeNode. Only implements
  // clauses are erased; an extends expression can execute arbitrary code.
  if (ts.isExpressionWithTypeArguments(node)) {
    return ts.isHeritageClause(node.parent) && node.parent.token === ts.SyntaxKind.ImplementsKeyword;
  }
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeNode(node)) return true;
  if (!ts.isPropertyDeclaration(node) && !ts.isMethodDeclaration(node)) return false;
  // Decorators and initialized fields have runtime behavior, unlike declared
  // fields and bodyless method signatures. Ordinary class fields stay gated.
  if (ts.getDecorators(node)?.length) return false;
  if (ts.isMethodDeclaration(node)) return node.body === undefined;
  return node.initializer === undefined && (ts.getModifiers(node)?.some(
    (modifier: ts.Modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword || modifier.kind === ts.SyntaxKind.AbstractKeyword,
  ) ?? false);
}

function closingSyntax(node: ts.Node): boolean {
  const parent = node.parent;
  switch (node.kind) {
    case ts.SyntaxKind.CloseBraceToken:
      return ts.isBlock(parent) || ts.isModuleBlock(parent) || ts.isCaseBlock(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isObjectLiteralExpression(parent);
    case ts.SyntaxKind.CloseParenToken:
      return ts.isCallExpression(parent) || ts.isNewExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isFunctionLike(parent);
    case ts.SyntaxKind.CloseBracketToken:
      return ts.isArrayLiteralExpression(parent) || ts.isElementAccessExpression(parent);
    case ts.SyntaxKind.SemicolonToken:
      return !ts.isEmptyStatement(parent) && !ts.isForStatement(parent);
    default:
      return false;
  }
}

/** Lines with no runtime tokens, independent of lcov hits and lane selection. */
function nonExecutableLines(text: string, path: string): Set<number> {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const skipped = new Set(source.getLineStarts().map((_start: number, index: number) => index + 1));
  const visit = (node: ts.Node): void => {
    if (typeOnlySyntax(node) || ts.isJSDoc(node)) return;
    const children = node.getChildren(source);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    const start = node.getStart(source);
    if (start === node.end || closingSyntax(node)) return;
    // Use parsed tokens rather than raw text: multiline literals, template
    // text and JSX text must not masquerade as comments or closing braces.
    const first = source.getLineAndCharacterOfPosition(start).line + 1;
    const last = source.getLineAndCharacterOfPosition(node.end - 1).line + 1;
    for (let line = first; line <= last; line += 1) skipped.delete(line);
  };
  visit(source);
  return skipped;
}

export function uncoveredRows(
  changed: Map<string, Set<number>>,
  union: Map<string, Map<number, number>>,
  isExecutable: (path: string) => boolean,
): string[] {
  const rows: string[] = [];
  for (const [path, lines] of [...changed.entries()].sort()) {
    const coverage = union.get(path);
    if (coverage === undefined) {
      // No lane ever loaded this file. Type-only modules emit nothing and are
      // exempt; anything else is untested by construction and fails closed.
      if (isExecutable(path)) rows.push(`${path}: no coverage record`);
      continue;
    }
    for (const line of [...lines].sort((a: number, b: number) => a - b)) {
      if (coverage.get(line) === 0) rows.push(`${path}:${line}`);
    }
  }
  return rows;
}

export function checkPatchCoverage(
  base: string,
  globs: readonly string[],
  root: string,
  skipped: Map<string, number> = new Map(),
): string[] {
  const diff = Bun.spawnSync(
    ["git", "diff", "--no-ext-diff", "--no-renames", "--unified=0", `${base}...HEAD`, "--"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (diff.exitCode !== 0) throw new Error(`git diff failed: ${diff.stderr.toString()}`);
  const files = globs.flatMap((glob: string) => [
    ...new Bun.Glob(glob).scanSync({ cwd: root, onlyFiles: true }),
  ]);
  const union = lcovUnion(
    files.map((file: string) => resolve(root, file)),
    root,
  );
  // Every path with added lines in a base...HEAD diff exists at HEAD, so the
  // read is trusted; an unexpected failure crashes the gate, which fails closed.
  const isExecutable = (path: string): boolean =>
    hasExecutableCode(readFileSync(resolve(root, path), "utf8"), path);
  const changed = changedLines(diff.stdout.toString());
  for (const [path, lines] of changed) {
    const nonExecutable = nonExecutableLines(readFileSync(resolve(root, path), "utf8"), path);
    const executable = new Set([...lines].filter((line: number) => !nonExecutable.has(line)));
    skipped.set(path, lines.size - executable.size);
    // Retain even empty entries: no SF record still fails for runtime modules.
    changed.set(path, executable);
  }
  return uncoveredRows(changed, union, isExecutable);
}

export function main(
  argv: readonly string[] = Bun.argv.slice(2),
  root: string = process.cwd(),
): number {
  const { values } = parseArgs({
    args: [...argv],
    options: { base: { type: "string" }, glob: { type: "string", multiple: true } },
    strict: true,
  });
  if (values.base === undefined || values.glob === undefined || values.glob.length === 0) {
    throw new Error("usage: check-patch-coverage.ts --base <ref> --glob <lcov-glob> [--glob ...]");
  }
  const skipped = new Map<string, number>();
  const rows = checkPatchCoverage(values.base, values.glob, root, skipped);
  for (const [path, count] of [...skipped.entries()].sort()) {
    console.log(`patch coverage: ${path}: ${count} AST-skipped changed line(s)`);
  }
  for (const row of rows) console.error(`uncovered: ${row}`);
  if (rows.length > 0) {
    console.error(`patch coverage: ${rows.length} changed executable line(s) uncovered`);
    return 1;
  }
  console.log("patch coverage: all changed executable lines are covered");
  return 0;
}

if (import.meta.main) process.exitCode = main();
