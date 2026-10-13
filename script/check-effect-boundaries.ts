import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { decodeJson, type Json } from "./quality-json";

const root = join(import.meta.dir, "..");
const allowlistPath = "script/conformance/effect-runner-sites.json";
const boundaryPath = "script/conformance/effect-boundary-sites.json";
const boundaryCodes = new Set(["R4_TAG_PREFIX", "R5_RACE_ALL", "R6_GEN_FINALLY", "R7_UNSCOPED_FORK", "R8_GLOBAL_LET", "R9_UNUSED_TAG", "R10_RESOURCE_SUCCEED"]);
const approvedEdges = new Set(["apps/openomni/src/cli/main.ts", "apps/openomni/src/gateway.ts"]);
// Test runners have exactly one owner per package. Bench programs are executable
// entrypoints, like the app edges, rather than reusable test runner helpers.
const RUNNER_OWNERS = new Set([
  "apps/openomni/test/helpers/effect.ts",
  "packages/agent/test/helpers/isolated.ts",
  "packages/channels/test/helpers/effect.ts",
  "packages/llm/test/helpers/runner.ts",
  "packages/machines/test/helpers/effect.ts",
  "packages/machines/test/ipc/helpers/effects.ts",
  "packages/agent/bench/turns.ts",
  "packages/agent/bench/store.ts",
]);
const runnerNames = new Set(["runPromise", "runPromiseExit", "runSync", "runSyncExit", "runFork", "runCallback"]);

export type BoundaryFinding = {
  readonly code: string;
  readonly file: string;
  readonly line: number;
  readonly failing: boolean;
  readonly site?: string;
};
type Origin = { readonly module: string; readonly members: readonly string[]; readonly node?: ts.Node; readonly tag?: ts.CallExpression };
type DeclaredFunction = { readonly exportedName: string; readonly node: ts.FunctionLikeDeclaration; readonly line: number };
type RunnerSite = { readonly file: string; readonly line: number; readonly key: string };
type Analysis = { readonly findings: BoundaryFinding[]; readonly sites: RunnerSite[]; readonly services: ServiceUsage[] };
export type ServiceUsage = { readonly file: string; readonly line: number; readonly key: string; readonly reads: number; readonly appLive: boolean };

function finding(code: string, file: string, line = 1): BoundaryFinding {
  return { code, file, line, failing: code !== "R2_ALLOWLISTED_RATCHET" };
}
function lineOf(node: ts.Node): number {
  return node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
}
function isEffectSpecifier(value: string): boolean {
  return value === "effect" || value.startsWith("effect/") || value.startsWith("@effect/");
}
function excludedSurface(file: string): boolean {
  return /^packages\/(protocol|ui)\/src\//.test(file) || file.startsWith("apps/desktop/src/") || file.startsWith("apps/openomni/src/tools/");
}
function sourcePath(file: string): boolean {
  return /^(apps|packages|script)\//.test(file) && /\.[cm]?tsx?$/.test(file) && !/(^|\/)(node_modules|dist|coverage|\.turbo|generated)\//.test(file);
}
function repositoryFiles(worktree: string): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return [...new Set(result.stdout.toString().split("\0").filter((file: string) => file && existsSync(join(worktree, file))))].sort();
}
function exported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier: ts.Modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}
function localFunctions(statement: ts.Statement): readonly [string, ts.FunctionLikeDeclaration][] {
  if (ts.isFunctionDeclaration(statement) && statement.name) return [[statement.name.text, statement]];
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration: ts.VariableDeclaration): [string, ts.FunctionLikeDeclaration][] => {
    const value = declaration.initializer;
    return ts.isIdentifier(declaration.name) && value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? [[declaration.name.text, value]] : [];
  });
}
function declaredFunctions(source: ts.SourceFile): DeclaredFunction[] {
  const declarations = new Map<string, ts.FunctionLikeDeclaration>();
  const names = new Map<string, string>();
  for (const statement of source.statements) {
    for (const [name, node] of localFunctions(statement)) {
      declarations.set(name, node);
      if (exported(statement)) names.set(name, name);
    }
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const entry of statement.exportClause.elements) names.set(entry.name.text, entry.propertyName?.text ?? entry.name.text);
  }
  return [...names].flatMap(([exportedName, local]: [string, string]) => {
    const node = declarations.get(local);
    return node ? [{ exportedName, node, line: lineOf(node) }] : [];
  });
}

/** Bind lexical identities with TypeScript; resolve provenance without requiring external declarations. */
class Provenance {
  private readonly checker: ts.TypeChecker;
  private readonly sources: ReadonlyMap<string, ts.SourceFile>;
  constructor(program: ts.Program, private readonly worktree: string) {
    this.checker = program.getTypeChecker();
    this.sources = new Map(program.getSourceFiles().map((source: ts.SourceFile) => [resolve(source.fileName), source]));
  }
  private module(specifier: string, source: ts.SourceFile): Origin | undefined {
    if (isEffectSpecifier(specifier)) return { module: specifier, members: [] };
    const workspace = /^@openomni\/([^/]+)$/.exec(specifier);
    const base = (workspace ? join(this.worktree, "packages", workspace[1] ?? "", "src/index") : resolve(dirname(source.fileName), specifier)).replace(/\.[cm]?jsx?$/, "");
    const candidates = [base, ...[".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx"].map((suffix: string) => base + suffix)];
    const file = candidates.find((candidate: string) => this.sources.has(candidate));
    return file ? { module: file, members: [] } : undefined;
  }
  private fromSpecifier(node: ts.Expression | undefined, source: ts.SourceFile): Origin | undefined {
    return node && ts.isStringLiteral(node) ? this.module(node.text, source) : undefined;
  }
  member(origin: Origin | undefined, name: string, seen = new Set<ts.Node | string>()): Origin | undefined {
    if (!origin) return undefined;
    if (isEffectSpecifier(origin.module)) return { module: origin.module, members: [...origin.members, name] };
    if (origin.node || origin.tag) return undefined;
    const key = `${origin.module}:${name}`;
    if (seen.has(key)) return undefined;
    const next = new Set(seen).add(key);
    const source = this.sources.get(origin.module);
    if (!source) return undefined;
    for (const statement of source.statements) {
      const result = this.exportedMember(statement, name, next);
      if (result) return result;
    }
    return undefined;
  }
  private exportedMember(statement: ts.Statement, name: string, seen: Set<ts.Node | string>): Origin | undefined {
    if (ts.isExportDeclaration(statement)) return this.exportDeclaration(statement, name, seen);
    if (exported(statement) && (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name?.text === name) return this.declaration(statement, seen);
    if (!exported(statement) || !ts.isVariableStatement(statement)) return undefined;
    const declaration = statement.declarationList.declarations.find((entry: ts.VariableDeclaration) => ts.isIdentifier(entry.name) && entry.name.text === name);
    return declaration ? this.declaration(declaration, seen) : undefined;
  }
  private exportDeclaration(node: ts.ExportDeclaration, name: string, seen: Set<ts.Node | string>): Origin | undefined {
    if (node.isTypeOnly) return undefined;
    const origin = this.fromSpecifier(node.moduleSpecifier, node.getSourceFile());
    const clause = node.exportClause;
    if (!clause) return this.member(origin, name, seen);
    if (ts.isNamespaceExport(clause)) return clause.name.text === name ? origin : undefined;
    const entry = clause.elements.find((element: ts.ExportSpecifier) => element.name.text === name && !element.isTypeOnly);
    if (!entry) return undefined;
    const local = entry.propertyName ?? entry.name;
    if (origin) return this.member(origin, local.text, seen);
    const symbol = this.checker.getExportSpecifierLocalTargetSymbol(entry);
    return this.declarations(symbol?.declarations, seen);
  }
  private declarations(nodes: readonly ts.Declaration[] | undefined, seen: Set<ts.Node | string>): Origin | undefined {
    for (const node of nodes ?? []) {
      if (seen.has(node)) continue;
      const result = this.declaration(node, new Set(seen).add(node));
      if (result) return result;
    }
    return undefined;
  }
  private declaration(node: ts.Declaration, seen: Set<ts.Node | string>): Origin | undefined {
    if (ts.isClassDeclaration(node)) {
      const base = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
      return base ? this.expression(base.expression, seen) : undefined;
    }
    if (ts.isFunctionDeclaration(node) || ts.isParameter(node)) return { module: node.getSourceFile().fileName, members: [], node };
    if (ts.isBindingElement(node)) return this.bindingElement(node, seen);
    if (ts.isVariableDeclaration(node)) return node.initializer ? this.expression(node.initializer, seen) ?? { module: node.getSourceFile().fileName, members: [], node: node.initializer } : undefined;
    if (ts.isNamespaceImport(node)) {
      const clause = node.parent;
      return clause.isTypeOnly ? undefined : this.fromSpecifier(clause.parent.moduleSpecifier, node.getSourceFile());
    }
    if (!ts.isImportSpecifier(node) || node.isTypeOnly || node.parent.parent.isTypeOnly) return undefined;
    const origin = this.fromSpecifier(node.parent.parent.parent.moduleSpecifier, node.getSourceFile());
    return this.member(origin, node.propertyName?.text ?? node.name.text, seen);
  }
  private dynamicImport(node: ts.CallExpression, source: ts.SourceFile, seen: Set<ts.Node | string>): Origin | undefined {
    const required = ts.isIdentifier(node.expression) && node.expression.text === "require" && !this.checker.getSymbolAtLocation(node.expression)?.valueDeclaration;
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword || required) return this.fromSpecifier(node.arguments[0], source);
    const callee = this.expression(node.expression, seen);
    if (effectApi(callee, "Context", ["Service"])) return { module: source.fileName, members: [], tag: node };
    if (callee?.tag) return callee;
    if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "Object" && node.expression.name.text === "assign"
      && !this.checker.getSymbolAtLocation(node.expression.expression)?.valueDeclaration) {
      const target = node.arguments[0];
      return target ? this.expression(target, seen) : undefined;
    }
    if (!callee?.node || !callable(callee.node) || seen.has(callee.node)) return undefined;
    const returned = returnedExpressions(callee.node);
    return returned.length === 1 && returned[0] ? this.expression(returned[0], new Set(seen).add(callee.node)) : undefined;
  }
  private bindingElement(node: ts.BindingElement, seen: Set<ts.Node | string>): Origin | undefined {
    const declaration = node.parent.parent;
    const origin = ts.isBindingElement(declaration) ? this.bindingElement(declaration, seen)
      : ts.isVariableDeclaration(declaration) && declaration.initializer ? this.expression(declaration.initializer, seen) : undefined;
    const key = node.propertyName ?? node.name;
    return ts.isIdentifier(key) || ts.isStringLiteral(key)
      ? this.member(origin, key.text, seen)
      : undefined;
  }
  expression(node: ts.Node, seen = new Set<ts.Node | string>()): Origin | undefined {
    if (ts.isIdentifier(node)) return this.declarations(this.checker.getSymbolAtLocation(node)?.declarations, seen);
    if (ts.isAwaitExpression(node)) return this.expression(node.expression, seen);
    if (ts.isCallExpression(node)) return this.dynamicImport(node, node.getSourceFile(), seen);
    if (ts.isPropertyAccessExpression(node)) return this.member(this.expression(node.expression, seen), node.name.text, seen);
    if (ts.isQualifiedName(node)) return this.member(this.expression(node.left, seen), node.right.text, seen);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return this.member(this.expression(node.expression, seen), node.argumentExpression.text, seen);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return this.expression(node.expression, seen);
    return undefined;
  }
  ownsResource(node: ts.Node): boolean {
    const type = this.checker.getTypeAtLocation(node);
    return ["close", "dispose", "unsubscribe"].some((name) => {
      const member = type.getProperty(name);
      return !!member && this.checker.getTypeOfSymbolAtLocation(member, node).getCallSignatures().length > 0;
    });
  }
}
function effectApi(origin: Origin | undefined, owner: string, methods: readonly string[]): boolean {
  return !!origin && isEffectSpecifier(origin.module) && originPath(origin).length === 2 && originPath(origin)[0] === owner && methods.includes(originPath(origin)[1] ?? "");
}
function originPath(origin: Origin | undefined): string[] {
  return origin ? [...origin.module.split("/").slice(1), ...origin.members] : [];
}
function isRunner(origin: Origin | undefined): boolean {
  if (!origin || !isEffectSpecifier(origin.module)) return false;
  const path = originPath(origin);
  const method = path.at(-1) ?? "";
  const owner = path.at(-2);
  if (runnerNames.has(method)) return owner === undefined || owner === "Effect" || owner === "Runtime";
  return (owner === "ManagedRuntime" && method === "make") || (owner === "Layer" && method === "toRuntime");
}
function moduleSpecifier(node: ts.Node): string | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isExternalModuleReference(node) && node.expression && ts.isStringLiteral(node.expression)) return node.expression.text;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) return node.argument.literal.text;
  if (!ts.isCallExpression(node)) return undefined;
  const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const required = ts.isIdentifier(node.expression) && node.expression.text === "require";
  const first = node.arguments[0];
  return (dynamic || required) && first && ts.isStringLiteral(first) ? first.text : undefined;
}
function importFindings(source: ts.SourceFile, file: string): BoundaryFinding[] {
  const result: BoundaryFinding[] = [];
  if (!excludedSurface(file)) return result;
  const code = file.startsWith("apps/openomni/src/tools/") ? "R1_TOOL_EFFECT_IMPORT" : "R1_EFFECT_IMPORT";
  const visit = (node: ts.Node): void => {
    const specifier = moduleSpecifier(node);
    if (specifier && isEffectSpecifier(specifier)) result.push(finding(code, file, lineOf(node)));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}
function nonExecutable(node: ts.Node): boolean {
  return (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) || ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node);
}
function valueReference(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return true;
  if (!ts.isIdentifier(node)) return false;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((parent as ts.Node & { readonly name?: ts.Node }).name === node && !ts.isShorthandPropertyAssignment(parent)) return false;
  return true;
}
function runnerSites(source: ts.SourceFile, file: string, provenance: Provenance, functions: readonly DeclaredFunction[]): RunnerSite[] {
  const result: RunnerSite[] = [];
  if (approvedEdges.has(file) || RUNNER_OWNERS.has(file)) return result;
  const names = new Map<ts.Node, string>(functions.map((entry: DeclaredFunction) => [entry.node, entry.exportedName]));
  const visit = (node: ts.Node, enclosing?: string): void => {
    if (nonExecutable(node)) return;
    const name = names.get(node) ?? enclosing;
    if (valueReference(node) && isRunner(provenance.expression(node))) {
      const line = lineOf(ts.isPropertyAccessExpression(node) ? node.name : node);
      result.push({ file, line, key: `${file}:${name ?? line}` });
    }
    ts.forEachChild(node, (child: ts.Node) => visit(child, name));
  };
  visit(source);
  return result;
}

type FunctionShape = { readonly entry: DeclaredFunction; readonly effect: boolean; readonly promise: boolean; readonly wrapper: boolean; readonly value: string | undefined };
function returnedExpressions(node: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (!node.body) return [];
  if (!ts.isBlock(node.body)) return [node.body];
  const results: ts.Expression[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child) && child.expression) results.push(child.expression);
    ts.forEachChild(child, visit);
  };
  visit(node.body);
  return results;
}
function effectExpression(node: ts.Expression, provenance: Provenance): boolean {
  const origin = provenance.expression(ts.isCallExpression(node) ? node.expression : node);
  const path = originPath(origin);
  return !!origin && isEffectSpecifier(origin.module) && (path[0] === "Effect" || origin.module === "effect/Effect") && !isRunner(origin);
}
function promiseExpression(node: ts.Expression, provenance: Provenance): boolean {
  if (!ts.isCallExpression(node)) return false;
  const origin = provenance.expression(node.expression);
  return (isRunner(origin) && /runPromise/.test(originPath(origin).at(-1) ?? "")) || (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Promise");
}
function functionShape(entry: DeclaredFunction, provenance: Provenance): FunctionShape {
  const type = entry.node.type;
  const reference = type && ts.isTypeReferenceNode(type) ? type : undefined;
  const typedEffect = reference && originPath(provenance.expression(reference.typeName)).at(-1) === "Effect";
  const typedPromise = reference?.typeName.getText() === "Promise";
  const returns = returnedExpressions(entry.node);
  const wrapper = returns.some((node: ts.Expression) => ts.isCallExpression(node) && isRunner(provenance.expression(node.expression)) && /runPromise/.test(originPath(provenance.expression(node.expression)).at(-1) ?? ""));
  return {
    entry,
    effect: !!typedEffect || returns.some((node: ts.Expression) => effectExpression(node, provenance)),
    promise: typedPromise || wrapper || !!ts.getModifiers(entry.node)?.some((modifier: ts.Modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) || returns.some((node: ts.Expression) => promiseExpression(node, provenance)),
    wrapper,
    value: reference?.typeArguments?.[0]?.getText().replace(/\s/g, ""),
  };
}
function promiseTwins(file: string, functions: readonly DeclaredFunction[], provenance: Provenance): BoundaryFinding[] {
  if (!/^packages\/[^/]+\/src\//.test(file)) return [];
  const shapes = functions.map((entry: DeclaredFunction) => functionShape(entry, provenance));
  const effects = shapes.filter((shape: FunctionShape) => shape.effect);
  return shapes.filter((shape: FunctionShape) => {
    if (!shape.promise) return false;
    const base = shape.entry.exportedName.replace(/(Promise|Async)$/, "");
    return shape.wrapper || effects.some((effect: FunctionShape) => effect.entry.exportedName === base || (shape.value !== undefined && shape.value === effect.value));
  }).map((shape: FunctionShape) => finding("R3_PROMISE_TWIN", file, shape.entry.line));
}

function productionSource(file: string): boolean {
  return /^(packages\/[^/]+|apps\/openomni)\/src\//.test(file) && !/\.(test|spec)\.[cm]?tsx?$/.test(file) && !/(^|\/)(__tests__|test|tests)\//.test(file);
}
/** v4 keys sit on the call itself (`Context.Service<I, S>(key)`, `Context.Reference(key, ...)`) or on the outer call of the class form (`Context.Service<I, S>()(key)`). */
function keyArgument(tag: ts.CallExpression): ts.Expression | undefined {
  if (tag.arguments[0]) return tag.arguments[0];
  const outer = tag.parent;
  return ts.isCallExpression(outer) && outer.expression === tag ? outer.arguments[0] : undefined;
}
function tagKey(tag: ts.CallExpression, provenance?: Provenance): string {
  const argument = keyArgument(tag);
  const key = argument && (provenance?.expression(argument)?.node ?? argument);
  if (key && ts.isStringLiteralLike(key)) return key.text;
  if (key && ts.isTemplateExpression(key) && key.head.text === "@openomni/bundle/"
    && key.templateSpans.length === 1 && /^\/[A-Za-z][A-Za-z0-9-]*$/.test(key.templateSpans[0]?.literal.text ?? "")) {
    const span = key.templateSpans[0];
    if (span) return `${key.head.text}${ts.isStringLiteralLike(span.expression) ? span.expression.text : "<template>"}${span.literal.text}`;
  }
  return "<computed>";
}
function validTagKey(key: string, file: string): boolean {
  const bundle = /^apps\/openomni\/src\/bundles\/([a-z][a-z0-9-]*)\//.exec(file);
  if (/^@openomni\/bundle\/([a-z][a-z0-9-]*|<template>)\/[A-Za-z][A-Za-z0-9-]*$/.test(key))
    return !bundle || key.startsWith(`@openomni/bundle/${bundle[1]}/`);
  const owner = bundle ? `bundle/${bundle[1]}` : file.split("/")[1];
  return key.startsWith(`@openomni/${owner}/`) && /^[A-Za-z][\w/-]*$/.test(key.slice(`@openomni/${owner}/`.length));
}
/** A never-valued presence probe does not declare a new service identity. */
function tagPresenceProbe(node: ts.CallExpression, provenance: Provenance): boolean {
  const parent = node.parent;
  return node.typeArguments?.length === 2 && node.typeArguments.every((type: ts.TypeNode) => type.kind === ts.SyntaxKind.NeverKeyword)
    && ts.isCallExpression(parent) && parent.arguments[parent.arguments.length - 1] === node
    && effectApi(provenance.expression(parent.expression), "Context", ["getOption"]);
}
function enclosingName(node: ts.Node): string {
  const names: string[] = [];
  for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isVariableDeclaration(parent)) && parent.name) names.unshift(parent.name.getText());
  }
  return names.join("/") || "<module>";
}

const sitePrinter = ts.createPrinter({ removeComments: true });
class BoundarySites {
  readonly findings: BoundaryFinding[] = [];
  private readonly occurrences = new Map<string, number>();
  add(code: string, file: string, node: ts.Node): void {
    const target = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : node;
    const text = sitePrinter.printNode(ts.EmitHint.Unspecified, target, node.getSourceFile());
    const digest = createHash("sha256").update(text).digest("hex").slice(0, 20);
    const identity = `${enclosingName(node)}:${digest}`;
    const key = `${code}:${file}:${identity}`;
    const occurrence = (this.occurrences.get(key) ?? 0) + 1;
    this.occurrences.set(key, occurrence);
    this.findings.push({ ...finding(code, file, lineOf(node)), site: `${identity}:${occurrence}` });
  }
}
function moduleLet(node: ts.Node): boolean {
  if (!ts.isVariableDeclarationList(node) || !(node.flags & ts.NodeFlags.Let)) return false;
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent) || ts.isClassLike(parent) || ts.isModuleDeclaration(parent)) return false;
  }
  return true;
}
function genFinalizers(node: ts.Node, provenance: Provenance): ts.TryStatement[] {
  const target = provenance.expression(node)?.node ?? node;
  if (!callable(target)) return [];
  const result: ts.TryStatement[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isFunctionLike(child)) return;
    if (ts.isTryStatement(child) && child.finallyBlock) result.push(child);
    ts.forEachChild(child, visit);
  };
  if (target.body) visit(target.body);
  return result;
}
function callBoundaryRules(node: ts.CallExpression, file: string, provenance: Provenance, sites: BoundarySites): void {
  const origin = provenance.expression(node.expression);
  if (effectApi(origin, "Context", ["Service", "Reference"])) {
    const key = tagKey(node, provenance);
    if (!validTagKey(key, file) && !(key === "<computed>" && tagPresenceProbe(node, provenance))) sites.add("R4_TAG_PREFIX", file, node);
  }
  if (effectApi(origin, "Effect", ["gen"])) {
    for (const argument of node.arguments) for (const block of genFinalizers(argument, provenance)) sites.add("R6_GEN_FINALLY", file, block);
  }
  if (effectApi(origin, "Layer", ["succeed"])) succeedRule(node, file, provenance, sites);
}
// Generation-local subscriptions own their bridge. Clock, Entropy, immutable
// snapshots/catalogs and the borrowed process observation port are pure values.
function succeedRule(node: ts.CallExpression, file: string, provenance: Provenance, sites: BoundarySites): void {
  const tag = node.arguments[0] && provenance.expression(node.arguments[0])?.tag;
  const application = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : node;
  const value = application === node ? node.arguments[1] : application.arguments[0];
  if (tag && value && (generationResource(tag, node, file) || provenance.ownsResource(value))) sites.add("R10_RESOURCE_SUCCEED", file, application);
}
function generationResource(tag: ts.CallExpression, provider: ts.Node, file: string): boolean {
  return tagKey(tag) === "@openomni/agent/ObservationSink"
    && file === "packages/agent/src/layers.ts"
    && enclosingName(provider).split("/").includes("AgentGenerationLive");
}
function boundaryRules(source: ts.SourceFile, file: string, provenance: Provenance, sites: BoundarySites): void {
  const visit = (node: ts.Node): void => {
    if (nonExecutable(node)) return;
    if (ts.isCallExpression(node)) callBoundaryRules(node, file, provenance, sites);
    if (valueReference(node)) {
      const origin = provenance.expression(node);
      if (effectApi(origin, "Effect", ["raceAll"])) sites.add("R5_RACE_ALL", file, node);
      const method = originPath(origin).at(-1) ?? "";
      if (/^fork/.test(method) && !["forkScoped", "forkIn"].includes(method) && effectApi(origin, "Effect", [method])) sites.add("R7_UNSCOPED_FORK", file, node);
    }
    if (file.startsWith("packages/") && moduleLet(node)) sites.add("R8_GLOBAL_LET", file, node);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

type TagUsage = { readonly tag: ts.CallExpression; readonly file: string; reads: number; appLive: boolean };
function serviceRead(node: ts.Node, provenance: Provenance): ts.CallExpression | undefined {
  if (ts.isYieldExpression(node) && node.asteriskToken && node.expression) return provenance.expression(node.expression)?.tag;
  if (!ts.isCallExpression(node)) return undefined;
  const origin = provenance.expression(node.expression);
  if (effectApi(origin, "Effect", ["service", "serviceOption", "serviceOptional"])) return node.arguments[0] && provenance.expression(node.arguments[0])?.tag;
  if (!effectApi(origin, "Context", ["get", "getOption", "getUnsafe"])) return undefined;
  const argument = node.arguments[node.arguments.length - 1];
  return argument && provenance.expression(argument)?.tag;
}
function appLiveRoots(source: ts.SourceFile): ts.Node[] {
  const roots: ts.Node[] = [];
  for (const statement of source.statements) {
    if (!exported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "AppLive") roots.push(statement);
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === "AppLive" && declaration.initializer) roots.push(declaration.initializer);
    }
  }
  return roots;
}
function appLiveProviders(sources: readonly ts.SourceFile[], worktree: string, provenance: Provenance): Set<ts.CallExpression> {
  const tags = new Set<ts.CallExpression>();
  // Reachability is a set union, so a node finished under one binding frame contributes nothing on a
  // second path through the same frame: memoising per frame keeps the walk linear in the DAG (the path
  // set `seen` alone revisits shared definitions once per path, which is exponential).
  const finished = new Map<ReadonlyMap<ts.Node, ts.Node>, Set<ts.Node>>();
  const visit = (node: ts.Node, bindings: ReadonlyMap<ts.Node, ts.Node> = new Map(), seen: ReadonlySet<ts.Node> = new Set()): void => {
    const done = finished.get(bindings) ?? new Set<ts.Node>();
    finished.set(bindings, done);
    if (seen.has(node) || done.has(node)) return;
    walk(node, bindings, new Set(seen).add(node));
    done.add(node);
  };
  const walk = (node: ts.Node, bindings: ReadonlyMap<ts.Node, ts.Node>, next: ReadonlySet<ts.Node>): void => {
    if (nonExecutable(node)) return;
    const descend = (child: ts.Node): void => visit(child, bindings, next);
    if (!productionSource(relative(worktree, node.getSourceFile().fileName))) return;
    if (callable(node)) {
      for (const returned of returnedExpressions(node)) descend(returned);
      return;
    }
    const callee = ts.isCallExpression(node) ? provenance.expression(node.expression)?.node : undefined;
    if (ts.isCallExpression(node) && callee && callable(callee)) {
      visit(callee, argumentBindings(callee, node, bindings), next);
      return;
    }
    const definition = provenance.expression(node)?.node;
    if (definition && definition !== node) descend(bindings.get(definition) ?? definition);
    const tag = providedTag(node, provenance);
    if (tag) tags.add(tag);
    ts.forEachChild(node, descend);
  };
  for (const source of sources) {
    if (relative(worktree, source.fileName) !== "apps/openomni/src/runtime.ts") continue;
    for (const node of appLiveRoots(source)) visit(node);
  }
  return tags;
}
function providedTag(node: ts.Node, provenance: Provenance): ts.CallExpression | undefined {
  if (!ts.isCallExpression(node) || !effectApi(provenance.expression(node.expression), "Layer", ["succeed", "effect", "scoped", "sync"])) return undefined;
  return node.arguments[0] && provenance.expression(node.arguments[0])?.tag;
}
function callable(node: ts.Node): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}
function argumentBindings(callee: ts.FunctionLikeDeclaration, call: ts.CallExpression, bindings: ReadonlyMap<ts.Node, ts.Node>): ReadonlyMap<ts.Node, ts.Node> {
  const result = new Map(bindings);
  callee.parameters.forEach((parameter, index) => {
    const argument = call.arguments[index] ?? parameter.initializer;
    if (argument) result.set(parameter, argument);
  });
  return result;
}
function serviceInventory(sources: readonly ts.SourceFile[], worktree: string, provenance: Provenance, sites: BoundarySites): ServiceUsage[] {
  const tags = new Map<ts.CallExpression, TagUsage>();
  const reads: ts.CallExpression[] = [];
  for (const source of sources) {
    const file = relative(worktree, source.fileName);
    if (!productionSource(file)) continue;
    const visit = (node: ts.Node): void => {
      if (nonExecutable(node)) return;
      if (ts.isCallExpression(node) && effectApi(provenance.expression(node.expression), "Context", ["Service"])) tags.set(node, { tag: node, file, reads: 0, appLive: false });
      const read = serviceRead(node, provenance);
      if (read) reads.push(read);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const read of reads) { const usage = tags.get(read); if (usage) usage.reads++; }
  for (const provided of appLiveProviders(sources, worktree, provenance)) { const usage = tags.get(provided); if (usage) usage.appLive = true; }
  return [...tags.values()].map((usage) => {
    if (!usage.reads) sites.add("R9_UNUSED_TAG", usage.file, usage.tag);
    return { file: usage.file, line: lineOf(usage.tag), key: tagKey(usage.tag), reads: usage.reads, appLive: usage.appLive };
  });
}

type BoundaryRow = { readonly code: string; readonly file: string; readonly site: string };
function boundaryIdentity(row: BoundaryRow): string { return `${row.code}:${row.file}:${row.site}`; }
function parseBoundaryRow(value: Json): BoundaryRow {
  if (!object(value) || Object.keys(value).sort().join(",") !== "code,file,site") throw new Error("Invalid boundary row");
  const { code, file, site } = value;
  if (typeof code !== "string" || !boundaryCodes.has(code) || typeof file !== "string" || !productionSource(file) || !sourcePath(file) || file.split("/").some((part) => part === ".." || part === ".") || typeof site !== "string" || !/^.+:[a-f0-9]{20}:[1-9]\d*$/.test(site)) throw new Error("Invalid boundary site");
  return { code, file, site };
}
function boundaryRatchet(worktree: string, findings: readonly BoundaryFinding[]): BoundaryFinding[] {
  const path = join(worktree, boundaryPath);
  if (!existsSync(path)) return [...findings, finding("BOUNDARY_MISSING_BASELINE", boundaryPath)];
  try {
    const parsed = decodeJson(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("Expected boundary array");
    const rows = parsed.map(parseBoundaryRow);
    const allowed = new Set(rows.map(boundaryIdentity));
    if (allowed.size !== rows.length) throw new Error("Duplicate boundary rows");
    const live = new Set<string>();
    const result = findings.map((entry): BoundaryFinding => {
      if (!entry.site) return entry;
      const identity = boundaryIdentity({ ...entry, site: entry.site });
      live.add(identity);
      return allowed.has(identity) ? { ...entry, failing: false } : entry;
    });
    for (const row of rows) if (!live.has(boundaryIdentity(row))) result.push({ ...finding("BOUNDARY_STALE_BASELINE", row.file), site: row.site });
    return result;
  } catch {
    return [...findings, finding("BOUNDARY_INVALID_BASELINE", boundaryPath)];
  }
}
function object(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function manifestFindings(worktree: string, files: readonly string[]): BoundaryFinding[] {
  const results: BoundaryFinding[] = [];
  for (const file of files.filter((path: string) => /(^|\/)package\.json$/.test(path) && !/(^|\/)(node_modules|dist)\//.test(path))) {
    const parsed = decodeJson(readFileSync(join(worktree, file), "utf8"));
    if (!object(parsed)) throw new Error(`Invalid manifest: ${file}`);
    const excluded = /^(packages\/(protocol|ui)|apps\/desktop)\/package\.json$/.test(file);
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const dependencies = parsed[key];
      if (dependencies === undefined) continue;
      if (!object(dependencies) || Object.values(dependencies).some((value: Json) => typeof value !== "string")) throw new Error(`Invalid dependencies: ${file}`);
      if (excluded && Object.keys(dependencies).some(isEffectSpecifier)) results.push(finding("R1_EFFECT_DEPENDENCY", file));
    }
  }
  return results;
}
function validRatchetEntry(entry: string): boolean {
  const separator = entry.lastIndexOf(":");
  const file = entry.slice(0, separator);
  const target = entry.slice(separator + 1);
  const surface = /^(apps|packages)\/[^/]+\/(test|tests|__tests__|bench)\//.test(file) || /^script\/.*\.(test|spec)\.[cm]?tsx?$/.test(file);
  return surface && sourcePath(file) && !file.split("/").includes("..") && /^(?:[1-9]\d*|[A-Za-z_$][\w$]*)$/.test(target);
}
function readAllowlist(worktree: string): { readonly entries: readonly string[]; readonly findings: readonly BoundaryFinding[] } {
  const path = join(worktree, allowlistPath);
  if (!existsSync(path)) return { entries: [], findings: [finding("R2_MISSING_ALLOWLIST", allowlistPath)] };
  try {
    const parsed = decodeJson(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("Expected an array");
    const entries = parsed.filter((entry: Json): entry is string => typeof entry === "string");
    if (entries.length !== parsed.length || new Set(entries).size !== entries.length || !entries.every(validRatchetEntry)) throw new Error("Invalid ratchet entries");
    return { entries, findings: [] };
  } catch {
    return { entries: [], findings: [finding("R2_INVALID_ALLOWLIST", allowlistPath)] };
  }
}

function analyze(worktree: string, files: readonly string[]): Analysis {
  const program = ts.createProgram(files.filter(sourcePath).map((file: string) => join(worktree, file)), { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve, noResolve: true, noLib: true });
  const diagnostics = program.getSyntacticDiagnostics();
  if (diagnostics.length) return { sites: [], services: [], findings: diagnostics.map((diagnostic: ts.Diagnostic) => finding("ANALYSIS_ERROR", diagnostic.file ? relative(worktree, diagnostic.file.fileName) : "script", diagnostic.file ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1 : 1)) };
  const provenance = new Provenance(program, worktree);
  const boundaries = new BoundarySites();
  const services = serviceInventory(program.getSourceFiles(), worktree, provenance, boundaries);
  const result: Analysis = { findings: manifestFindings(worktree, files), sites: [], services };
  for (const source of program.getSourceFiles()) {
    const file = relative(worktree, source.fileName).replaceAll("\\", "/");
    const functions = declaredFunctions(source);
    result.findings.push(...importFindings(source, file), ...promiseTwins(file, functions, provenance));
    result.sites.push(...runnerSites(source, file, provenance, functions));
    if (productionSource(file)) boundaryRules(source, file, provenance, boundaries);
  }
  result.findings.push(...boundaries.findings);
  return result;
}
export function effectServiceInventory(worktree = root): readonly ServiceUsage[] {
  const result = analyze(worktree, repositoryFiles(worktree));
  if (result.findings.some((entry) => entry.code === "ANALYSIS_ERROR")) throw new Error("Cannot inventory invalid source");
  return result.services;
}
function staleFinding(worktree: string, entry: string): BoundaryFinding {
  const separator = entry.lastIndexOf(":");
  const file = entry.slice(0, separator);
  const target = entry.slice(separator + 1);
  if (/^\d+$/.test(target)) return finding("R2_STALE_ALLOWLIST", file, Number(target));
  const path = join(worktree, file);
  const source = existsSync(path) ? ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ESNext, true) : undefined;
  return finding("R2_STALE_ALLOWLIST", file, source ? declaredFunctions(source).find((entry: DeclaredFunction) => entry.exportedName === target)?.line ?? 1 : 1);
}
export function checkEffectBoundaryFindings(worktree = root): readonly BoundaryFinding[] {
  const allowlist = readAllowlist(worktree);
  let result: Analysis;
  try {
    result = analyze(worktree, repositoryFiles(worktree));
  } catch {
    result = { sites: [], services: [], findings: [finding("ANALYSIS_ERROR", "script")] };
  }
  const findings = [...boundaryRatchet(worktree, result.findings), ...allowlist.findings];
  const allowed = new Set(allowlist.entries);
  const live = new Set(result.sites.map((site: RunnerSite) => site.key));
  for (const site of result.sites) findings.push(finding(allowed.has(site.key) ? "R2_ALLOWLISTED_RATCHET" : "R2_EFFECT_RUNNER", site.file, site.line));
  for (const entry of allowed) if (!live.has(entry)) findings.push(staleFinding(worktree, entry));
  const distinct = new Map(findings.map((entry: BoundaryFinding) => [`${entry.code}:${entry.file}:${entry.line}:${entry.site ?? ""}`, entry]));
  return [...distinct.values()].sort((left: BoundaryFinding, right: BoundaryFinding) => left.file.localeCompare(right.file) || left.line - right.line || left.code.localeCompare(right.code));
}
function formatFinding(entry: BoundaryFinding): string {
  return `${entry.file}:${entry.line} ${entry.code}${entry.failing ? "" : " allowlisted (ratchet)"}`;
}
export function checkEffectBoundaries(worktree = root): string[] {
  return checkEffectBoundaryFindings(worktree).map(formatFinding);
}
export function main(args = Bun.argv.slice(2)): number {
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--root" && args[1] && !args[1].startsWith("--"))) {
    console.log(JSON.stringify({ code: "INVALID_ARGUMENTS", message: "Expected [--root <dir>]; baseline updates are forbidden" }));
    return 1;
  }
  const findings = checkEffectBoundaryFindings(resolve(args[1] ?? root));
  for (const entry of findings) console.log(entry.code === "ANALYSIS_ERROR" ? JSON.stringify(entry) : formatFinding(entry));
  return findings.some((entry: BoundaryFinding) => entry.failing) ? 1 : 0;
}
if (import.meta.main) process.exitCode = main();
