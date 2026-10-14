/**
 * Invariant (#1318): no eager value-import cycle exists. Distinct from
 * inventory wiring, allowed edges and dead exports.
 *
 * Import-cycle ratchet. Baseline: 0 value-import cycles.
 *
 * Builds the eager value-import graph over every src file in packages/* and
 * apps/* — static `import`/`export … from` statements, following relative
 * specifiers and workspace package names — and fails when a cycle exists.
 * Type-only edges (`import type`, `export type … from`, clauses whose named
 * specifiers are all `type`-prefixed) are skipped: they are erased at runtime
 * and cannot cause TDZ/partial-init hazards. Lazy `await import()` edges are
 * skipped for the same reason.
 *
 * Modes:
 *   bun run script/check-import-cycles.ts             check the tree
 *   bun run script/check-import-cycles.ts --self-test discrimination bench on
 *                                                     synthetic graphs only
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { decodeJson } from "./quality-json";
import { runScriptMain } from "./main-runner";
import { assertTopologyComplete, TOPOLOGY } from "./topology";

const root = join(import.meta.dir, "..");

function listSourceFiles(): string[] {
  const files: string[] = [];
  for (const workspace of TOPOLOGY) {
    const sourceDir = join(root, workspace.dir, "src");
    if (!existsSync(sourceDir)) {
      throw new Error(`topology workspace ${workspace.dir} has no src directory`);
    }
    const workspaceFiles = [
      ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: sourceDir, absolute: true }),
    ];
    if (workspaceFiles.length === 0) {
      throw new Error(`topology workspace ${workspace.dir} contributes zero source modules`);
    }
    files.push(...workspaceFiles);
  }
  if (files.length === 0) throw new Error("topology produced an empty import graph");
  return files.sort();
}

function workspaceEntryPoints(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const workspace of TOPOLOGY) {
    const manifestPath = join(root, workspace.dir, "package.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`topology workspace ${workspace.dir} has no package.json`);
    }
    const manifest = z.object({ name: z.string(), main: z.string().min(1) }).safeParse(
      decodeJson(readFileSync(manifestPath, "utf8")),
    );
    if (!manifest.success || manifest.data.name !== workspace.packageName) {
      throw new Error(
        `topology workspace ${workspace.dir} expected package ${workspace.packageName} with a main entry`,
      );
    }
    entries.set(workspace.packageName, resolve(dirname(manifestPath), manifest.data.main));
  }
  return entries;
}

function isErasedDeclaration(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause?.isTypeOnly) return true;
    const bindings = clause?.namedBindings;
    return !clause?.name && bindings !== undefined && ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 && bindings.elements.every((entry) => entry.isTypeOnly);
  }
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 &&
    clause.elements.every((entry) => entry.isTypeOnly);
}

/** Static value-import specifiers of one module (type-only edges excluded). */
export function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const parsed = ts.createSourceFile("imports.ts", source, ts.ScriptTarget.Latest, true);
  for (const node of parsed.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    if (!node.moduleSpecifier || !ts.isStringLiteralLike(node.moduleSpecifier)) continue;
    if (isErasedDeclaration(node)) continue;
    specifiers.push(node.moduleSpecifier.text);
  }
  return specifiers;
}

function resolveSpecifier(
  fromFile: string,
  specifier: string,
  workspaces: Map<string, string>,
): string | undefined {
  let base: string | undefined;
  if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else if (workspaces.has(specifier)) {
    base = workspaces.get(specifier);
  } else {
    return undefined; // external dependency — out of scope
  }
  if (base === undefined) return undefined;
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  return candidates.find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate));
}

export function findCycles(graph: Map<string, readonly string[]>): string[][] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  function visit(node: string): void {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const state = color.get(next) ?? WHITE;
      if (state === GRAY) {
        const cycle = stack.slice(stack.indexOf(next));
        const key = [...cycle].sort().join(" -> ");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push([...cycle, next]);
        }
      } else if (state === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of [...graph.keys()].sort()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node);
  }
  return cycles;
}

/** Eager value-import graph over every topology workspace's src tree. */
export function buildGraph(): Map<string, readonly string[]> {
  const files = listSourceFiles();
  const inScope = new Set(files);
  const workspaces = workspaceEntryPoints();
  const graph = new Map<string, readonly string[]>();
  for (const file of files) {
    const edges = new Set<string>();
    for (const specifier of valueImportSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(file, specifier, workspaces);
      if (resolved && resolved !== file && inScope.has(resolved)) edges.add(resolved);
    }
    graph.set(file, [...edges].sort());
  }
  return graph;
}

export function selfTest(): void {
  const cyclic = new Map<string, readonly string[]>([
    ["a.ts", ["b.ts"]],
    ["b.ts", ["c.ts", "a.ts"]],
    ["c.ts", []],
  ]);
  const acyclic = new Map<string, readonly string[]>([
    ["a.ts", ["b.ts", "c.ts"]],
    ["b.ts", ["c.ts"]],
    ["c.ts", []],
  ]);
  const typeOnly = valueImportSpecifiers(
    'import type { A } from "./a.js";\nexport type { B } from "./b.js";\nimport { type C } from "./c.js";\nimport { type D, e } from "./e.js";\nimport "./side-effect.js";\nimport { f } from "./f.js";',
  );
  const failures: string[] = [];
  if (findCycles(cyclic).length !== 1) failures.push("planted cycle not detected");
  if (findCycles(acyclic).length !== 0) failures.push("false positive on acyclic graph");
  if (typeOnly.join(",") !== "./e.js,./side-effect.js,./f.js") {
    failures.push(`value-edge extraction wrong: [${typeOnly.join(", ")}]`);
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`SELF-TEST FAIL: ${failure}`);
    process.exit(1);
  }
  console.log("OK: import-cycle self-test — planted cycle red, acyclic green, type edges erased");
}

/** Check the shipped tree; exits 1 with every cycle printed when one exists. */
export async function main(graph: Map<string, readonly string[]> = buildGraph()): Promise<void> {
  assertTopologyComplete();
  const cycles = findCycles(graph);
  if (cycles.length > 0) {
    for (const cycle of cycles) {
      console.error(`CYCLE: ${cycle.map((file) => relative(root, file)).join("\n    -> ")}`);
    }
    console.error(
      `\n${cycles.length} value-import cycle(s) found — baseline is 0. Break the cycle (extract a shared leaf module) instead of adding to it.`,
    );
    process.exit(1);
  }
  console.log(`OK: import-cycle check — ${graph.size} modules, 0 value-import cycles`);
}

if (import.meta.main) { if (process.argv.includes("--self-test")) selfTest(); else await runScriptMain(main); }
