import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { projectOptions } from "./check-types-census";
import type { TestSelectionReceipt } from "./run-quality-mutations";

export type Entry = { path: string; sha256: string; bytes: number; category: string; language: string };
export type Contract = { projects: string[]; roots: string[]; topology: boolean };
export type Inventory = { files: Entry[]; historical: Entry[]; configurations: { path: string; sha256: string }[] };
export const mutationFailure: { current: { code: string; message: string } | null } = { current: null };
export class MutationError {
  readonly name = "MutationError";
  constructor(readonly code: string, readonly message: string, readonly reach?: { test: string; receipt: TestSelectionReceipt }) { }
}
export function fail(code: string, message: string): never {
  mutationFailure.current = { code, message };
  throw new MutationError(code, message);
}
export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
export function pathIn(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".."))
    return fail("schema", `Unsafe relative path: ${path}`);
  const absolute = resolve(root, path);
  if (existsSync(absolute) && (lstatSync(absolute).isSymbolicLink() || !realpathSync(absolute).startsWith(`${realpathSync(root)}/`)))
    return fail("schema", `Source escapes root: ${path}`);
  return absolute;
}
function projectProgram(root: string, path: string): ts.Program {
  pathIn(root, path);
  console.error(`[mutation] compiler project ${path}`);
  try {
    const parsed = projectOptions(root, path);
    return ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true, incremental: false, composite: false });
  } catch { return fail("configuration", `invalid native project: ${path}`); }
}
export function inventoryCompilerOptions(root: string): ts.CompilerOptions {
  return {
    strict: true, noEmit: true, allowJs: true, checkJs: false,
    rootDir: root, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, skipLibCheck: true,
  };
}
export function* programs(directory: string, contract: Contract, inventory: Inventory): Generator<ts.Program, void, undefined> {
  const root = realpathSync(directory);
  const covered = new Set<string>();
  for (const path of contract.projects) {
    const program = projectProgram(root, path);
    // Canonical root ownership: a native project covers only its root files, in
    // contract order, so transitive-only inventory members enter the fallback.
    for (const name of program.getRootFileNames()) covered.add(realpathSync(name));
    yield program;
  }
  const remaining = inventory.files.filter((file) => ["typescript", "javascript"].includes(file.language))
    .map((file) => pathIn(root, file.path)).filter((path) => !covered.has(realpathSync(path)));
  if (remaining.length) {
    const options = inventoryCompilerOptions(root);
    const host = ts.createCompilerHost(options);
    host.getCurrentDirectory = () => root;
    yield ts.createProgram(remaining, options, host);
  }
}
export function formatDiagnostic(diagnostic: ts.Diagnostic, cwd: string): string {
  return ts.formatDiagnostics([diagnostic], {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => cwd, getNewLine: () => "\n",
  });
}
// The one diagnostic ownership rule shared by baseline and candidate checks:
// a project owns file-less diagnostics and diagnostics attributed to its own
// root files. Diagnostics on transitive members belong to the project (or the
// inventory fallback) that lists them as roots.
export function projectRootPaths(rootNames: Iterable<string>): Set<string> {
  const roots = new Set<string>();
  for (const name of rootNames) roots.add(realpathSync(name));
  return roots;
}
export function ownsDiagnostic(roots: ReadonlySet<string>, diagnostic: ts.Diagnostic): boolean {
  return diagnostic.file === undefined || roots.has(realpathSync(diagnostic.file.fileName));
}
export function diagnostics(items: Iterable<ts.Program>, cwd = process.cwd()): string[] {
  const errors: string[] = [];
  for (const program of items) {
    const roots = projectRootPaths(program.getRootFileNames());
    for (const diagnostic of ts.getPreEmitDiagnostics(program))
      if (ownsDiagnostic(roots, diagnostic)) errors.push(formatDiagnostic(diagnostic, cwd));
  }
  return errors;
}
function visitExecutionTree(root: string, hasher: Bun.CryptoHasher, directory: string): void {
  for (const name of readdirSync(directory).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const path = join(directory, name);
    if (lstatSync(path).isSymbolicLink()) {
      const link = readlinkSync(path);
      const destination = relative(root, realpathSync(path));
      if (isAbsolute(link) || destination === ".." || destination.startsWith(`..${sep}`))
        fail("isolation", `External symlink in execution copy: ${relative(root, path)}`);
      hasher.update(`${relative(root, path)}\0link\0${link}\0`);
    } else if (lstatSync(path).isDirectory()) visitExecutionTree(root, hasher, path);
    else hasher.update(`${relative(root, path)}\0${sha256(readFileSync(path))}\0`);
  }
}
export function executionTreeHash(directory: string): string {
  const root = realpathSync(directory);
  const hasher = new Bun.CryptoHasher("sha256");
  visitExecutionTree(root, hasher, root);
  return hasher.digest("hex");
}
