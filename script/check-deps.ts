// Invariant (#1318): dependency edges follow the topology table — a package
// imports only the workspaces the table allows, nothing undeclared. Distinct
// from inventory wiring, import cycles and dead exports.
import { Glob } from "bun";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { PlainValueSchema } from "../packages/protocol/src/json.js";
import { commandOutput } from "./command-output";
import { runScriptMain } from "./main-runner";
import { assertTopologyComplete, TOPOLOGY, type WorkspaceTopology } from "./topology";

type PackageRule = {
  displayName: string;
  packageJsonPath: string;
  packageName: string;
  allowedDeps: "none" | "any-except-self" | Set<string>;
  srcAllowedDeps?: Set<string>;
};

/** Barrel-only cross-package import specifier, shared by both direction checks. */
const openomniBarrelImportPattern = () =>
  /(?:from\s+|import\s+|import\s*\(\s*)["'](@openomni\/[^"'/]+)(?:\/[^"']*)?["']/g;

const RULES = Object.fromEntries(
  TOPOLOGY.map((workspace: WorkspaceTopology) => [
    workspace.key,
    {
      displayName: workspace.displayName,
      packageJsonPath: `${workspace.dir}/package.json`,
      packageName: workspace.packageName,
      allowedDeps:
        typeof workspace.allowedDeps === "string"
          ? workspace.allowedDeps
          : new Set<string>(workspace.allowedDeps),
      srcAllowedDeps:
        workspace.srcAllowedDeps === undefined
          ? undefined
          : new Set<string>(workspace.srcAllowedDeps),
    },
  ]),
) as Record<string, PackageRule>;

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const Manifest = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
}).catchall(PlainValueSchema);
type Manifest = z.infer<typeof Manifest>;

/** The layer check for `<pkg>/src/`, which may be stricter than the manifest's. */
function isAllowedSourceDep(rule: PackageRule, dep: string): boolean {
  if (!dep.startsWith("@openomni/")) return true;
  return rule.srcAllowedDeps === undefined ? isAllowedDep(rule, dep) : rule.srcAllowedDeps.has(dep);
}

function isAllowedDep(rule: PackageRule, dep: string): boolean {
  if (rule.allowedDeps === "none") {
    return false;
  }

  if (rule.allowedDeps === "any-except-self") {
    return dep !== rule.packageName;
  }

  return rule.allowedDeps.has(dep);
}

async function readJson(path: string): Promise<Manifest> {
  const file = Bun.file(path);
  const exists = await file.exists();

  if (!exists) {
    throw new Error(`Missing required file: ${path}`);
  }

  const text = await file.text();
  return Manifest.parse(JSON.parse(text));
}

function collectOpenOmniDeps(pkg: Manifest): string[] {
  const deps = new Set<string>();

  for (const field of DEP_FIELDS) {
    const value = pkg[field];

    if (!value || typeof value !== "object") {
      continue;
    }

    for (const depName of Object.keys(value)) {
      if (depName.startsWith("@openomni/")) {
        deps.add(depName);
      }
    }
  }

  return Array.from(deps).sort();
}

function isTestFile(path: string): boolean {
  if (path.includes("/test/") || path.includes("/tests/") || path.includes("/__tests__/")) {
    return true;
  }

  return (
    path.endsWith(".test.ts") ||
    path.endsWith(".spec.ts") ||
    path.endsWith(".test.tsx") ||
    path.endsWith(".spec.tsx")
  );
}

/**
 * Paths never scanned: build output, dependencies, tests, the gate scripts
 * themselves, and untracked local dirs — research clones pinned under tmp/
 * (#533) and nested worktrees under .claude/ — which would otherwise break
 * local runs while CI stays green (#552).
 */
function isExcludedFromScan(filePath: string): boolean {
  return (
    filePath.includes("/node_modules/") ||
    filePath.startsWith("node_modules/") ||
    filePath.includes("/dist/") ||
    filePath.startsWith("dist/") ||
    filePath.startsWith("tmp/") ||
    filePath.startsWith(".claude/") ||
    isTestFile(filePath) ||
    filePath.startsWith("script/")
  );
}

function lineNumberForOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function suggestBarrelImport(importPath: string): string {
  const packageName = importPath.match(/^(@openomni\/[^/]+)/)?.[1];
  return packageName ?? importPath;
}

function parentTraversalDepth(importPath: string): number {
  let depth = 0;
  for (const segment of importPath.split("/")) {
    if (segment !== "..") {
      break;
    }
    depth += 1;
  }
  return depth;
}

type ScannedSource = { filePath: string; source: string };

/**
 * Single owner of repository source traversal: one glob walk, one exclusion
 * rule, one read. Every validator below consumes this instead of repeating the
 * scan options.
 */
async function* scanRepositorySources(pattern: string, root = "."): AsyncGenerator<ScannedSource, void, void> {
  const sourceGlob = new Glob(pattern);

  for await (const filePath of sourceGlob.scan({
    cwd: root,
    absolute: false,
    dot: false,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    if (isExcludedFromScan(filePath)) {
      continue;
    }

    yield { filePath, source: await Bun.file(join(root, filePath)).text() };
  }
}

const BUNDLE_PREFIX = "apps/openomni/src/bundles/";
const BUNDLE_CORE_IMPORTS = new Set<string>(
  TOPOLOGY.flatMap((workspace) => (workspace.key === "openomniApp" ? workspace.allowedDeps : [])),
);

function bundleNamespace(file: string): string | undefined {
  const path = file.startsWith(BUNDLE_PREFIX) ? file.slice(BUNDLE_PREFIX.length) : "";
  return path.includes("/") ? path.split("/")[0] : undefined;
}

export type BundleImportFinding = {
  readonly code:
    | "BUNDLE_CROSS_NAMESPACE"
    | "BUNDLE_COMPUTED_IMPORT"
    | "BUNDLE_PARSE_ERROR"
    | "BUNDLE_UNRESOLVED_IMPORT"
    | "BUNDLE_IMPORT_NOT_ALLOWED"
    | "BUNDLE_CONFIG_ERROR";
  readonly file: string;
  readonly line: number;
};

type ModuleEdge = { readonly line: number; readonly specifier: string | undefined };
type Loader = "require" | "createRequire" | "module";

function nodeModuleImport(node: ts.Node): boolean {
  if (ts.isSourceFile(node)) return false;
  if (ts.isImportDeclaration(node)) {
    return (
      ts.isStringLiteral(node.moduleSpecifier) &&
      ["module", "node:module"].includes(node.moduleSpecifier.text)
    );
  }
  return nodeModuleImport(node.parent);
}

function isCreateRequireProperty(
  node: ts.Node,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return (
      node.name.text === "createRequire" &&
      loaderOrigin(node.expression, checker, seen) === "module"
    );
  }
  return (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === "createRequire" &&
    loaderOrigin(node.expression, checker, seen) === "module"
  );
}

function declaredLoader(
  node: ts.Node,
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Loader | undefined {
  if (
    (ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)) &&
    nodeModuleImport(declaration)
  )
    return "module";
  if (
    ts.isBindingElement(declaration) &&
    (declaration.propertyName ?? declaration.name).getText() === "createRequire"
  ) {
    const variable = declaration.parent.parent;
    if (
      ts.isVariableDeclaration(variable) &&
      variable.initializer &&
      loaderOrigin(variable.initializer, checker, seen) === "module"
    )
      return "createRequire";
  }
  if (
    ts.isImportSpecifier(declaration) &&
    nodeModuleImport(declaration) &&
    (declaration.propertyName ?? declaration.name).text === "createRequire"
  )
    return "createRequire";
  if (
    ts.isIdentifier(node) &&
    node.text === "require" &&
    declaration.getSourceFile().isDeclarationFile
  )
    return "require";
  return undefined;
}

/** Follow bindings, not spellings: local shadowed require functions are ordinary calls. */
function loaderOrigin(
  node: ts.Node,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): Loader | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return loaderOrigin(node.expression, checker, seen);
  if (ts.isCallExpression(node)) {
    return loaderOrigin(node.expression, checker, seen) === "createRequire" ? "require" : undefined;
  }
  if (isCreateRequireProperty(node, checker, seen)) return "createRequire";
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return ts.isIdentifier(node) && node.text === "require" ? "require" : undefined;
  if (seen.has(symbol)) return undefined;
  seen.add(symbol);
  const declarations = [
    ...(symbol.declarations ?? []),
    ...(symbol.flags & ts.SymbolFlags.Alias
      ? (checker.getAliasedSymbol(symbol).declarations ?? [])
      : []),
  ];
  for (const declaration of declarations) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return loaderOrigin(declaration.initializer, checker, seen);
    }
    const origin = declaredLoader(node, declaration, checker, seen);
    if (origin) return origin;
  }
  return undefined;
}

function moduleArgument(node: ts.Node, checker: ts.TypeChecker): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return node.argument.literal;
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      loaderOrigin(node.expression, checker) === "require")
  ) {
    return node.arguments[0] ?? node;
  }
  return undefined;
}

function moduleEdges(source: ts.SourceFile, checker: ts.TypeChecker): readonly ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  function visit(node: ts.Node): void {
    const argument = moduleArgument(node, checker);
    if (argument) {
      edges.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        specifier: ts.isStringLiteralLike(argument) ? argument.text : undefined,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return edges;
}

function bundleCompilerOptions(root: string, findings: BundleImportFinding[]): ts.CompilerOptions {
  const defaults: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
  };
  const config = ts.findConfigFile(join(root, "apps/openomni"), ts.sys.fileExists);
  if (!config) return defaults;
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {
        findings.push({ code: "BUNDLE_CONFIG_ERROR", file: relative(root, config), line: 1 });
      },
    },
  );
  for (const diagnostic of parsed?.errors ?? []) {
    findings.push({
      code: "BUNDLE_CONFIG_ERROR",
      file: relative(root, diagnostic.file?.fileName ?? config),
      line: diagnostic.file
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1
        : 1,
    });
  }
  return { ...defaults, ...parsed?.options };
}

function isLocalSpecifier(specifier: string, options: ts.CompilerOptions): boolean {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    Object.keys(options.paths ?? {}).some((alias) =>
      specifier.startsWith(alias.split("*")[0] ?? alias),
    )
  );
}

/** Single import-ban owner. Follow all local edges, including type edges and barrels. */
export async function checkBundleImports(
  directory = process.cwd(),
): Promise<readonly BundleImportFinding[]> {
  const root = realpathSync(directory);
  const roots: string[] = [];
  for await (const { filePath } of scanRepositorySources(
    "{apps,packages}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
    root,
  )) {
    roots.push(join(root, filePath));
  }
  const bundles = roots.filter((file) => bundleNamespace(relative(root, file)));
  if (bundles.length === 0) return [];
  const findings: BundleImportFinding[] = [];
  const options = bundleCompilerOptions(root, findings);
  if (findings.length > 0) return findings;
  const program = ts.createProgram(roots, options);
  const checker = program.getTypeChecker();
  const edges = new Map<string, readonly ModuleEdge[]>();
  const visited = new Set<string>();
  function follow(edge: ModuleEdge, file: string, namespace: string): void {
    const location = { file: relative(root, file), line: edge.line };
    if (edge.specifier === undefined) {
      findings.push({ code: "BUNDLE_COMPUTED_IMPORT", ...location });
      return;
    }
    if (edge.specifier.startsWith("@openomni/") && !BUNDLE_CORE_IMPORTS.has(edge.specifier)) {
      findings.push({ code: "BUNDLE_IMPORT_NOT_ALLOWED", ...location });
      return;
    }
    const target = ts.resolveModuleName(edge.specifier, file, options, ts.sys).resolvedModule
      ?.resolvedFileName;
    if (!target) {
      if (isLocalSpecifier(edge.specifier, options)) {
        findings.push({ code: "BUNDLE_UNRESOLVED_IMPORT", ...location });
      }
      return;
    }
    const targetPath = relative(root, resolve(target));
    const targetNamespace = bundleNamespace(targetPath);
    if (targetNamespace && targetNamespace !== namespace) {
      findings.push({ code: "BUNDLE_CROSS_NAMESPACE", ...location });
    } else if (!targetPath.includes("node_modules/") && !targetPath.startsWith("../")) {
      visit(resolve(target), namespace);
    }
  }
  function visit(file: string, namespace: string): void {
    const key = `${namespace}:${file}`;
    if (visited.has(key)) return;
    visited.add(key);
    const path = relative(root, file);
    const source = program.getSourceFile(file);
    if (!source) {
      findings.push({ code: "BUNDLE_UNRESOLVED_IMPORT", file: path, line: 1 });
      return;
    }
    for (const diagnostic of program.getSyntacticDiagnostics(source)) {
      findings.push({
        code: "BUNDLE_PARSE_ERROR",
        file: path,
        line: source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
      });
    }
    const imports = edges.get(file) ?? moduleEdges(source, checker);
    edges.set(file, imports);
    for (const edge of imports) follow(edge, file, namespace);
  }
  for (const file of bundles) {
    const namespace = bundleNamespace(relative(root, file));
    if (namespace) visit(file, namespace);
  }
  return [
    ...new Map(
      findings.map((finding) => [`${finding.code}:${finding.file}:${finding.line}`, finding]),
    ).values(),
  ];
}

async function validateDependencyDirection(): Promise<string[]> {
  const violations: string[] = [];

  for (const rule of Object.values(RULES)) {
    const pkgJson = await readJson(rule.packageJsonPath);
    const deps = collectOpenOmniDeps(pkgJson);

    for (const dep of deps) {
      if (!isAllowedDep(rule, dep)) {
        violations.push(
          `VIOLATION: ${rule.displayName} depends on ${dep} — not allowed by layer order`,
        );
      }
    }
  }

  return violations;
}

function packageDirOf(rule: PackageRule): string {
  return rule.packageJsonPath.replace(/\/package\.json$/, "");
}

/**
 * Layer-order check at the source level. package.json manifests cannot see
 * phantom imports (a bare `import "@openomni/agent"` resolves through the
 * hoisted node_modules even when the manifest never declares it), so the
 * dependency-direction rules are enforced against actual import specifiers.
 */
async function validateSourceImportDirection(): Promise<string[]> {
  const violations: string[] = [];
  const owners = Object.values(RULES).map((rule) => ({
    rule,
    srcPrefix: `${packageDirOf(rule)}/src/`,
  }));
  const importPattern = openomniBarrelImportPattern();

  for await (const { filePath, source } of scanRepositorySources("**/*.{ts,tsx}")) {
    const owner = owners.find(({ srcPrefix }) => filePath.startsWith(srcPrefix));
    if (!owner) continue;

    for (const match of source.matchAll(importPattern)) {
      const dep = match[1];
      if (dep && !isAllowedSourceDep(owner.rule, dep)) {
        const line = lineNumberForOffset(source, match.index);
        violations.push(
          `VIOLATION: ${filePath}:${line} source-imports ${dep} — not allowed by layer order for ${owner.rule.displayName} (manifest check cannot see phantom imports)`,
        );
      }
    }
  }

  return violations;
}

const CHANNELS_SRC_PREFIX = "packages/channels/src/";
const CHANNELS_ROUTER_PREFIX = "packages/channels/src/router/";
const CHANNELS_JUDGMENT_PREFIXES = [
  CHANNELS_ROUTER_PREFIX,
  "packages/channels/src/authn/",
] as const;
const CHANNELS_STORE_PREFIX = "packages/channels/src/store/";
const CHANNELS_BANDED_DEP = "@openomni/agent";

/**
 * The agent-gate surfaces the channels judgment band may name from
 * @openomni/agent (#1246 — the former policy engine and the scoped
 * ledger ports live in the agent package now): permission evaluation plus the
 * handle-scoped decision-fact perimeter port (#1317 moved the surface-key
 * store into channels).
 * Brain surfaces (session stores, catalog, model plane, …) are NOT reachable
 * from the router — the gateway selects sessions but never reads or writes
 * session content (S1), and domain isolation inside the one DB is by store
 * surface (S2).
 */
const CHANNELS_JUDGMENT_AGENT_SURFACES = new Set([
  // packages/channels/src/authn/decision.ts
  "evaluatePermission",
  "decisionFromEvaluation",
  // packages/channels/src/router/{external-message,message-ports}.ts
  "PolicyEvaluationInput",
  // packages/channels/src/router/stores.ts
  "createDecisionFactPort",
]);

/**
 * The persistence seams the channels store band (`src/store/`, the perimeter
 * stores absorbed from the old ledger in #1246) may name from
 * @openomni/agent: the sub-adapter guard and the timestamp wrapper (#1317
 * moved the stored-identity schemas and the surface-key store into channels).
 * Never a session, catalog, gate, or model surface.
 */
const CHANNELS_STORE_AGENT_SURFACES = new Set([
  "requireSubAdapter",
  "withStoreTimestamps",
]);

function isChannelsJudgmentPath(filePath: string): boolean {
  return CHANNELS_JUDGMENT_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function channelsAgentBand(filePath: string): ReadonlySet<string> | undefined {
  if (isChannelsJudgmentPath(filePath)) return CHANNELS_JUDGMENT_AGENT_SURFACES;
  if (filePath.startsWith(CHANNELS_STORE_PREFIX)) return CHANNELS_STORE_AGENT_SURFACES;
  return undefined;
}

/**
 * S8 intra-package banding for the channels gateway (docs/gateway-design.md
 * §7 S8; five-package shape, #1246). The package-level whitelist admits
 * @openomni/agent, but only the perimeter JUDGMENT band — `src/router/`
 * (routing, physical correlation, send kernel) and `src/authn/` (channel
 * authn) — and the STORE band (`src/store/`, the perimeter stores) may use
 * it. The driver sub-band (discord/, github/, telegram/, support/,
 * websocket.ts, channel-authn.ts) stays on the dumb-driver contract
 * {protocol}: adding a platform = one driver file + one server registration
 * line, zero security review of the router.
 */
function isChannelsBandingViolation(filePath: string, dep: string): boolean {
  if (!filePath.startsWith(CHANNELS_SRC_PREFIX)) return false;
  if (dep !== CHANNELS_BANDED_DEP) return false;
  return channelsAgentBand(filePath) === undefined;
}

/**
 * S8 driver→router edge ban (#707): a file outside the judgment band may not
 * relative-import anything under `src/router/` — the router is reached only
 * through the composition root's injected ports, never laterally from a
 * driver. (`src/authn/` stays importable: channel-authn.ts is the drivers'
 * authn entry and predates the router band.)
 */
function isChannelsDriverRouterEdge(filePath: string, importPath: string): boolean {
  if (!filePath.startsWith(CHANNELS_SRC_PREFIX)) return false;
  if (isChannelsJudgmentPath(filePath)) return false;
  // The package barrel is the composition root's export surface, not a
  // driver — it is how apps/openomni reaches createGatewayRouter.
  if (filePath === "packages/channels/src/index.ts") return false;
  if (!importPath.startsWith(".")) return false;
  const baseDir = filePath.split("/").slice(0, -1);
  const segments = [...baseDir];
  for (const segment of importPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/").startsWith(CHANNELS_ROUTER_PREFIX);
}

/**
 * S8 channels↔agent surface pin (#707 shape, #1246 vocabulary): a banded
 * channels file importing @openomni/agent may name ONLY its band's perimeter
 * surfaces, through static named `import`/`export … from` clauses. Everything
 * else is refused outright — namespace/default imports, `export *`
 * re-exports, dynamic `import(...)`, and `require(...)` would all reach (or
 * launder to relative importers) every brain surface the named scan pins out.
 * The named clause is the ONLY road.
 */
function channelsAgentSurfaceViolations(filePath: string, source: string): string[] {
  const band = channelsAgentBand(filePath);
  if (band === undefined) return [];
  const violations: string[] = [];
  const namedPattern =
    /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@openomni\/agent["']/g;
  const broadPattern =
    /import\s+(?:type\s+)?(?:\*\s+as\s+\w+|\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']@openomni\/agent["']/g;
  const exportStarPattern = /export\s*\*\s*(?:as\s+\w+\s*)?from\s*["']@openomni\/agent["']/g;
  const dynamicPattern =
    /(?:import\s*\(\s*|require\s*\(\s*)["'`]@openomni\/agent(?:\/[^"'`]*)?["'`]/g;
  for (const match of source.matchAll(namedPattern)) {
    const names = (match[1] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map(
        (entry) =>
          entry
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0]
            ?.trim() ?? "",
      );
    for (const name of names) {
      if (name.length > 0 && !band.has(name)) {
        const line = lineNumberForOffset(source, match.index);
        violations.push(
          `VIOLATION: ${filePath}:${line} names agent surface ${name} — S8: this channels band may name only its perimeter surfaces (${[...band].join(", ")}), never brain surfaces`,
        );
      }
    }
  }
  for (const match of source.matchAll(broadPattern)) {
    const line = lineNumberForOffset(source, match.index);
    violations.push(
      `VIOLATION: ${filePath}:${line} uses a namespace/default import of @openomni/agent — S8: the channels perimeter must name the agent surfaces explicitly`,
    );
  }
  for (const match of source.matchAll(exportStarPattern)) {
    const line = lineNumberForOffset(source, match.index);
    violations.push(
      `VIOLATION: ${filePath}:${line} re-exports @openomni/agent wholesale — S8: a channels barrel may not launder brain surfaces to relative importers`,
    );
  }
  for (const match of source.matchAll(dynamicPattern)) {
    const line = lineNumberForOffset(source, match.index);
    violations.push(
      `VIOLATION: ${filePath}:${line} loads @openomni/agent dynamically — S8: the static named-import pin is the only road to the agent from the channels perimeter`,
    );
  }
  return violations;
}

async function validateChannelsIntraPackageBanding(): Promise<string[]> {
  const violations: string[] = [];
  const importPattern = openomniBarrelImportPattern();
  const relativeImportPattern = /(?:from\s+|import\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']*)["']/g;

  for await (const { filePath, source } of scanRepositorySources(
    `${CHANNELS_SRC_PREFIX}**/*.{ts,tsx}`,
  )) {
    for (const match of source.matchAll(importPattern)) {
      const dep = match[1];
      if (dep && isChannelsBandingViolation(filePath, dep)) {
        const line = lineNumberForOffset(source, match.index);
        violations.push(
          `VIOLATION: ${filePath}:${line} imports ${dep} — S8 banding: only the channels judgment band (src/router/, src/authn/) and store band (src/store/) may import @openomni/agent; drivers stay on {protocol}`,
        );
      }
    }
    for (const match of source.matchAll(relativeImportPattern)) {
      const importPath = match[1];
      if (importPath && isChannelsDriverRouterEdge(filePath, importPath)) {
        const line = lineNumberForOffset(source, match.index);
        violations.push(
          `VIOLATION: ${filePath}:${line} imports ${importPath} — S8 banding: drivers may not reach into src/router/; the router is wired only through the composition root's injected ports`,
        );
      }
    }
    violations.push(...channelsAgentSurfaceViolations(filePath, source));
  }

  return violations;
}

// ─── #1247: agent directory bands ──────────────────────────────────────────

const AGENT_SRC_PREFIX = "packages/agent/src/";

/**
 * #1276 agent responsibility bands (five-band table, issue #1276). Key =
 * directory under packages/agent/src; `internal` = sibling bands a file may
 * relative-import; `externalBans` = module-specifier prefixes refused
 * outright; `tokenBans` = ambient authority tokens the band may not name.
 * `plugins/<name>/` has extra edges checked in agentRelativeImportViolation:
 * a plugin may import only `core/api.ts` from the core and never a sibling
 * plugin. Existing violations are pinned by AGENT_BAND_RATCHET below: the
 * count per file may shrink, never grow (#1255 turns the ratchet into a full
 * ban and inverts the remaining core->plugin and core->inspect edges).
 */
const AGENT_BANDS: Record<string, {
  readonly internal: ReadonlySet<string>;
  readonly externalBans: readonly string[];
  readonly tokenBans: readonly RegExp[];
}> = {
  core: {
    internal: new Set(["core"]),
    externalBans: ["ai", "@ai-sdk/"],
    tokenBans: [/\bDate\.now\b/, /\bMath\.random\b/, /\bcrypto\.randomUUID\b/, /\bprocess\.env\b/],
  },
  plugins: { internal: new Set(["plugins"]), externalBans: [], tokenBans: [] },
  model: { internal: new Set(["model"]), externalBans: [], tokenBans: [] },
  // inspect/ folds durable reads; it keeps full core access (pre-#1276 it read
  // kernel/session/store) but may never touch the live bus (core/bus).
  inspect: { internal: new Set(["inspect", "core"]), externalBans: [], tokenBans: [] },
  testing: { internal: new Set(["testing", "core", "model", "plugins", "inspect"]), externalBans: [], tokenBans: [] },
};

/** inspect/ may import session reads but never the live bus (issue table 1). */
const AGENT_INSPECT_BUS_BAN = "core/bus";

/**
 * #1276: exactly five plugin directories. agentBandViolations flags a file in
 * any other `plugins/<dir>/`, and packages/agent/test/plugins/
 * plugins-layout.test.ts asserts the live directory listing equals this table.
 */
export const AGENT_PLUGINS = ["action", "alarm", "compaction", "hook", "tool"] as const;

/** `../../index` (or `../..`) resolves to the package root barrel, which
 * re-exports every band at once; review r2 closed this classification hole. */
function isAgentPackageRoot(rest: string): boolean {
  return rest === "" || rest === "index" || rest === "index.ts";
}

function agentBandOf(filePath: string): string | undefined {
  if (!filePath.startsWith(AGENT_SRC_PREFIX)) return undefined;
  const rest = filePath.slice(AGENT_SRC_PREFIX.length);
  if (!rest.includes("/")) return undefined; // root files (index.ts) assemble the namespaces
  const dir = rest.split("/")[0] ?? "";
  return dir in AGENT_BANDS ? dir : undefined;
}

function resolveAgentRelative(filePath: string, importPath: string): string {
  const segments = filePath.split("/").slice(0, -1);
  for (const segment of importPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

/**
 * #1276 plugin edges: a file under `plugins/<name>/` may relative-import its
 * own plugin and `core/api.ts` and nothing else inside the package. Sibling
 * plugins and every other `core/`, `model/`, `inspect/` or `testing/` path
 * are violations (pre-existing ones are pinned by the ratchet; #1255 owns
 * the inversion of the remaining inspect edge).
 */
function pluginImportViolation(filePath: string, targetRest: string): string | undefined {
  const ownPlugin = filePath.slice(AGENT_SRC_PREFIX.length).split("/")[1] ?? "";
  if (targetRest.startsWith("plugins/")) {
    const targetPlugin = targetRest.split("/")[1] ?? "";
    return targetPlugin === ownPlugin || targetPlugin === ""
      ? undefined
      : `plugins/${ownPlugin}/ may not import its sibling plugins/${targetPlugin}/`;
  }
  if (targetRest === "core/api.ts" || targetRest === "core/api") return undefined;
  if (targetRest === "core" || targetRest.startsWith("core/")) {
    return `plugins/${ownPlugin}/ may import only core/api.ts from the core (got ${targetRest})`;
  }
  if (isAgentPackageRoot(targetRest)) {
    return `plugins/${ownPlugin}/ may not import the package root barrel (it re-exports every band)`;
  }
  const target = targetRest.split("/")[0] ?? "";
  if (target in AGENT_BANDS) {
    return `plugins/${ownPlugin}/ may not import ${target}/`;
  }
  return undefined;
}

/** The band verdict for one relative import, or undefined when it is legal. */
function agentRelativeImportViolation(
  filePath: string,
  band: string,
  internal: ReadonlySet<string>,
  spec: string,
): string | undefined {
  const resolved = resolveAgentRelative(filePath, spec);
  const packageRoot = AGENT_SRC_PREFIX.slice(0, -1);
  if (resolved !== packageRoot && !resolved.startsWith(AGENT_SRC_PREFIX)) return undefined;
  const rest = resolved === packageRoot ? "index" : resolved.slice(AGENT_SRC_PREFIX.length);
  if (band === "inspect" && rest.startsWith(AGENT_INSPECT_BUS_BAN)) {
    return "inspect/ folds the journal and may never touch the live bus";
  }
  if (band === "plugins") return pluginImportViolation(filePath, rest);
  if (isAgentPackageRoot(rest)) {
    return Object.keys(AGENT_BANDS).every((key) => internal.has(key))
      ? undefined
      : `${band}/ may not import the package root barrel (it re-exports every band)`;
  }
  // Review r2 addendum: a band-root barrel (`../model`) classifies as its band,
  // exactly like a deep path — the slash-only classifier undercounted it.
  const head = rest.split("/")[0] ?? "";
  const target = head.endsWith(".ts") ? head.slice(0, -3) : head;
  if (target !== "" && target in AGENT_BANDS && !internal.has(target)) {
    return `${band}/ may not import ${target}/`;
  }
  return undefined;
}

/** The band verdict for one external specifier, or undefined when it is legal. */
function agentExternalImportViolation(
  band: string,
  bans: readonly string[],
  spec: string,
): string | undefined {
  for (const ban of bans) {
    if (spec === ban || spec.startsWith(ban.endsWith("/") ? ban : `${ban}/`)) {
      return `${band}/ may not depend on ${ban}`;
    }
  }
  return undefined;
}

/** Pure per-file scan so the self-test and script tests can plant violations. */
export function agentBandViolations(filePath: string, source: string): string[] {
  const band = agentBandOf(filePath);
  const rules = band === undefined ? undefined : AGENT_BANDS[band];
  if (band === undefined || rules === undefined) return [];
  const violations: string[] = [];
  if (band === "plugins") {
    const plugin = filePath.slice(AGENT_SRC_PREFIX.length).split("/")[1] ?? "";
    if (!(AGENT_PLUGINS as readonly string[]).includes(plugin)) {
      violations.push(
        `VIOLATION: ${filePath} — #1276: plugins/ holds exactly {${AGENT_PLUGINS.join(", ")}}; plugins/${plugin}/ is not in the table`,
      );
    }
  }
  const importPattern = /(?:from\s+|import\s+|import\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const spec = match[1];
    if (spec === undefined) continue;
    const reason = spec.startsWith(".")
      ? agentRelativeImportViolation(filePath, band, rules.internal, spec)
      : agentExternalImportViolation(band, rules.externalBans, spec);
    if (reason === undefined) continue;
    const line = lineNumberForOffset(source, match.index);
    violations.push(`VIOLATION: ${filePath}:${line} imports ${spec} — #1247 bands: ${reason}`);
  }
  for (const token of rules.tokenBans) {
    const global = new RegExp(token.source, "g");
    for (const match of source.matchAll(global)) {
      const line = lineNumberForOffset(source, match.index);
      violations.push(
        `VIOLATION: ${filePath}:${line} names ambient authority ${match[0]} — #1247 bands: ${band}/ takes clock/entropy/config through ports`,
      );
    }
  }
  return violations;
}

/**
 * #1276 ratchet baseline, TIGHT: every pin equals the file's HEAD actual count
 * under the corrected band-root classifier, so there is no slack to grow into
 * (review r3 F1; the issue's literal "equal totals" is an Owner-recorded
 * deviation). Band ratchet 25 at HEAD with tight per-file pins; the pre-move
 * tree measures 45 under the same classifier, of which 16 were
 * plugins/compaction imports now routed through core/api and 4 were
 * product-choice edges the move removed (see the reconciliation receipt).
 * Includes the core/retry.ts
 * +1 slash-only-classifier undercount correction (r2 addendum). A new file, a
 * higher count, OR A PIN ABOVE THE ACTUAL fails: shrinkage lowers the pin in
 * the same PR. #1255 drives every entry to zero.
 */
const AGENT_BAND_RATCHET: ReadonlyMap<string, number> = new Map([
  // #1307 moved every core -> plugins/compaction edge behind the compaction
  // seam and inverted the plugin -> inspect/history edge; the remaining pins
  // are core -> inspect/history and core/model edges (#1255 owns those).
  ["packages/agent/src/core/commit.ts", 1],
  ["packages/agent/src/core/failure.ts", 1],
  ["packages/agent/src/core/gate/decide.ts", 2],
  // #1310 split mailbox.ts; its grandfathered inspect/history edge moved to recovery.ts.
  ["packages/agent/src/core/recovery.ts", 1],
  ["packages/agent/src/core/ports.ts", 1],
  // pre-existing value import (instanceof LlmRunFailure); undercounted by the
  // slash-only classifier before #1276 (r2 addendum measurement correction).
  ["packages/agent/src/core/retry.ts", 1],
  ["packages/agent/src/core/run.ts", 2],
  ["packages/agent/src/core/turn.ts", 1],
  ["packages/agent/src/core/types.ts", 1],
  ["packages/agent/src/model/errors.ts", 1],
]);


/** HEAD actual violation total; the pins are tight, so this is the pin sum. */
export function agentBandRatchetTotal(): number {
  let total = 0;
  for (const count of AGENT_BAND_RATCHET.values()) total += count;
  return total;
}

export async function validateAgentBands(root = "."): Promise<string[]> {
  const counts = new Map<string, string[]>();
  let pinnedFilesScanned = 0;
  for await (const { filePath, source } of scanRepositorySources(
    `${AGENT_SRC_PREFIX}**/*.ts`,
    root,
  )) {
    if (AGENT_BAND_RATCHET.has(filePath)) pinnedFilesScanned += 1;
    const found = agentBandViolations(filePath, source);
    if (found.length > 0) counts.set(filePath, found);
  }
  const violations: string[] = [];
  for (const [filePath, found] of [...counts.entries()].sort()) {
    const allowed = AGENT_BAND_RATCHET.get(filePath) ?? 0;
    if (found.length > allowed) {
      violations.push(
        ...found,
        `VIOLATION: ${filePath} has ${found.length} band violations over the #1276 ratchet of ${allowed} — shrink only, never grow`,
      );
    }
  }
  // Review r3 F1: slack is a growth surface, so a pin above the actual count
  // fails closed — shrinkage is autonomous and lowers the pin in the same PR.
  // Scoped to trees holding at least one pinned file (scratch gate fixtures
  // have none); the repository always does, and deleting a single pinned file
  // there still fails closed through the remaining ones.
  for (const [filePath, allowed] of pinnedFilesScanned === 0
    ? []
    : [...AGENT_BAND_RATCHET.entries()].sort()) {
    const actual = counts.get(filePath)?.length ?? 0;
    if (actual < allowed) {
      violations.push(
        `VIOLATION: ${filePath} pin exceeds actual (${allowed} > ${actual}): lower the pin`,
      );
    }
  }
  return violations;
}

// ─── #1276: apps import only the @openomni/agent barrel ────────────────────

/**
 * #1276 check (c): a file under `apps/` importing a path inside
 * `packages/agent/src/` — either a deep `@openomni/agent/...` specifier or a
 * relative path that resolves into the agent package — fails. Apps compose
 * through the barrel only.
 */
export function appsAgentInternalViolations(filePath: string, source: string): string[] {
  if (!filePath.startsWith("apps/")) return [];
  const violations: string[] = [];
  const importPattern = /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const spec = match[1];
    if (spec === undefined) continue;
    const deep = spec.startsWith("@openomni/agent/");
    const relative = spec.startsWith(".") &&
      resolveAgentRelative(filePath, spec).startsWith("packages/agent/src");
    if (!deep && !relative) continue;
    const line = lineNumberForOffset(source, match.index);
    violations.push(
      `VIOLATION: ${filePath}:${line} imports ${spec} — #1276 bands: apps import only the @openomni/agent barrel, never agent internals`,
    );
  }
  return violations;
}

export async function validateAppsAgentBarrel(root = "."): Promise<string[]> {
  const violations: string[] = [];
  for await (const { filePath, source } of scanRepositorySources("apps/**/*.{ts,tsx}", root)) {
    violations.push(...appsAgentInternalViolations(filePath, source));
  }
  return violations;
}

// #1343: app-owned direct ledger and entity/SQLite assembly references are
// pinned at today's call sites. The import perimeter above is independent.
export function loadAppResponsibilityPins(root = "."): ReadonlyMap<string, number> {
  const path = join(root, "script/conformance/app-agent-responsibility.json");
  const value = z.object({ files: z.record(z.string(), z.number().int().nonnegative().finite()) }).strict()
    .parse(JSON.parse(readFileSync(path, "utf8")));
  return new Map(Object.entries(value.files));
}

/** Count code references, excluding trivia and literal text. */
export function appAgentResponsibilityCount(source: string): number {
  const sourceFile = ts.createSourceFile("app.ts", source, ts.ScriptTarget.Latest, true);
  const masked = source.split("");
  const hide = (start: number, end: number): void => {
    for (let i = start; i < end; i++) {
      if (masked[i] !== "\n") masked[i] = " ";
    }
  };
  const visit = (node: ts.Node): void => {
    for (const position of [node.pos, node.end]) {
      for (const range of [...(ts.getLeadingCommentRanges(source, position) ?? []), ...(ts.getTrailingCommentRanges(source, position) ?? [])]) {
        hide(range.pos, range.end);
      }
    }
    if (node.kind === ts.SyntaxKind.StringLiteral ||
        node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
        node.kind === ts.SyntaxKind.TemplateHead ||
        node.kind === ts.SyntaxKind.TemplateMiddle ||
        node.kind === ts.SyntaxKind.TemplateTail ||
        node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      hide(node.getStart(sourceFile), node.end);
    }
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  const code = masked.join("");
  return [...code.matchAll(/\b(?:kernel\.(?:commit|materialize|indexSession)|createSessionEntityLayer|createSessionEntityRunTurn|SqliteClient\.layer|SingleRunner\.layer)\b/g)].length;
}

export async function validateAppAgentResponsibilities(
  root = ".",
  pins: ReadonlyMap<string, number> = loadAppResponsibilityPins(root),
): Promise<string[]> {
  const counts = new Map<string, number>();
  for await (const { filePath, source } of scanRepositorySources("apps/openomni/src/**/*.ts", root)) {
    counts.set(filePath, appAgentResponsibilityCount(source));
  }
  const violations: string[] = [];
  for (const path of new Set([...counts.keys(), ...pins.keys()])) {
    const actual = counts.get(path) ?? 0;
    const pin = pins.get(path) ?? 0;
    if (actual !== pin) violations.push(`VIOLATION: ${path} direct agent responsibility actual ${actual}, pin ${pin} (${actual > pin ? "growth" : "stale pin"})`);
  }
  return violations.sort();
}

/**
 * #1247 S8 perimeter pin: `packages/agent/src/index.ts` exports exactly
 * the five namespaces plus at most these six named exports consumed by
 * `packages/channels` (legal channels -> agent band edges). Shrink-only:
 * removals are fine, any new name or any other export form fails. No epic
 * child owns retiring the named list; retirement is a separate decision.
 */
const AGENT_INDEX_NAMESPACES: ReadonlySet<string> = new Set([
  "Core",
  "Bundle",
  "Model",
  "Inspect",
  "Testing",
]);

const AGENT_INDEX_PINNED_NAMED_EXPORTS: ReadonlySet<string> = new Set([
  "decisionFromEvaluation",
  "evaluatePermission",
  "PolicyEvaluationInput",
  "requireSubAdapter",
  "withStoreTimestamps",
  "createDecisionFactPort",
]);

const AGENT_INDEX_PATH = "packages/agent/src/index.ts";

type PerimeterScan = {
  readonly violations: string[];
  readonly namespaces: Set<string>;
  readonly named: string[];
};

function perimeterLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function perimeterFormViolation(sourceFile: ts.SourceFile, node: ts.Node): string {
  return `VIOLATION: ${AGENT_INDEX_PATH}:${perimeterLine(sourceFile, node)} uses an export form outside the #1276 surface (five namespaces + pinned S8 names only)`;
}

function scanNamedExports(sourceFile: ts.SourceFile, clause: ts.NamedExports, scan: PerimeterScan): void {
  for (const specifier of clause.elements) {
    // `specifier.name` is the EXPORTED name (the one after `as`);
    // `propertyName` is the local source name when aliased.
    const exported = specifier.name.text;
    scan.named.push(exported);
    if (!AGENT_INDEX_PINNED_NAMED_EXPORTS.has(exported)) {
      scan.violations.push(
        `VIOLATION: ${AGENT_INDEX_PATH}:${perimeterLine(sourceFile, specifier)} exports ${exported} outside the pinned S8 perimeter — shrink only, never grow`,
      );
    }
  }
}

function scanExportDeclaration(
  sourceFile: ts.SourceFile,
  declaration: ts.ExportDeclaration,
  scan: PerimeterScan,
): void {
  const clause = declaration.exportClause;
  if (clause !== undefined && ts.isNamespaceExport(clause)) {
    scan.namespaces.add(clause.name.text);
    return;
  }
  if (clause !== undefined && ts.isNamedExports(clause)) {
    scanNamedExports(sourceFile, clause, scan);
    return;
  }
  // `export * from "..."` without `as`, or any other clause shape.
  scan.violations.push(perimeterFormViolation(sourceFile, declaration));
}

function scanIndexStatement(sourceFile: ts.SourceFile, statement: ts.Statement, scan: PerimeterScan): void {
  if (ts.isExportDeclaration(statement)) {
    scanExportDeclaration(sourceFile, statement, scan);
    return;
  }
  if (ts.isExportAssignment(statement)) {
    // `export default ...` / `export = ...`
    scan.violations.push(perimeterFormViolation(sourceFile, statement));
    return;
  }
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    // `export const/function/class/type/interface ...` declarations.
    scan.violations.push(perimeterFormViolation(sourceFile, statement));
  }
}

export function agentIndexPerimeterViolations(source: string): string[] {
  const scan: PerimeterScan = { violations: [], namespaces: new Set(), named: [] };
  const sourceFile = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    scanIndexStatement(sourceFile, statement, scan);
  }
  for (const name of scan.namespaces) {
    if (!AGENT_INDEX_NAMESPACES.has(name)) {
      scan.violations.push(
        `VIOLATION: ${AGENT_INDEX_PATH} exports namespace ${name} outside the five #1276 namespaces`,
      );
    }
  }
  if (scan.named.length > AGENT_INDEX_PINNED_NAMED_EXPORTS.size) {
    scan.violations.push(
      `VIOLATION: ${AGENT_INDEX_PATH} has ${scan.named.length} named exports over the pinned ${AGENT_INDEX_PINNED_NAMED_EXPORTS.size} — shrink only, never grow`,
    );
  }
  return scan.violations;
}

export async function validateAgentIndexPerimeter(root = "."): Promise<string[]> {
  const file = Bun.file(`${root}/${AGENT_INDEX_PATH}`);
  if (!(await file.exists())) return [];
  return agentIndexPerimeterViolations(await file.text());
}

async function validateDeepImports(): Promise<string[]> {
  const violations: string[] = [];
  // Matches both `from "@openomni/.../src/..."` and side-effect `import "@openomni/.../src/..."`
  const importPattern =
    /(?:from\s+|import\s+|import\s*\(\s*)["'](@openomni\/[^"']+\/src\/[^"']*)["']/g;

  for await (const { filePath, importPath, line } of scannedImports(importPattern)) {
    const base = `VIOLATION: ${filePath}:${line} imports ${importPath} — use package barrel instead`;
    if (Bun.argv.includes("--fix-suggestions")) {
      const suggested = suggestBarrelImport(importPath);
      violations.push(`${base} (suggestion: ${suggested})`);
    } else {
      violations.push(base);
    }
  }

  return violations;
}

async function* scannedImports(pattern: RegExp): AsyncGenerator<{
  filePath: string;
  importPath: string;
  line: number;
}, void, void> {
  for await (const { filePath, source } of scanRepositorySources("**/*.{ts,tsx}")) {
    for (const match of source.matchAll(pattern)) {
      const importPath = match[1];
      if (importPath === undefined) continue;
      yield { filePath, importPath, line: lineNumberForOffset(source, match.index) };
    }
  }
}

async function validateDeepRelativeImports(): Promise<string[]> {
  const violations: string[] = [];
  const importPattern = /(?:from\s+|import\s*\(\s*)["'](\.{2}\/[^"']*)["']/g;

  for await (const { filePath, importPath, line } of scannedImports(importPattern)) {
    const isSelfRootImport = importPath.startsWith("../../src/");
    const isDeepRelativeImport = parentTraversalDepth(importPath) >= 3;
    if (!isSelfRootImport && !isDeepRelativeImport) continue;
    const reason = isSelfRootImport ? "self-root relative import" : "deep relative import";
    violations.push(
      `VIOLATION: ${filePath}:${line} imports ${importPath} — ${reason}; use a closer relative import or a domain barrel`,
    );
  }

  return violations;
}

// See docs/golden-principles.local.md for the full list.

async function validateGoldenPrinciples(): Promise<string[]> {
  const violations: string[] = [];

  for await (const { filePath, source } of scanRepositorySources("**/*.{ts,tsx}")) {
    const lines = source.split("\n");

    for (const [index, line] of lines.entries()) {
      const lineNum = index + 1;

      // #5: No `as any`
      if (/\bas\s+any\b/.test(line)) {
        violations.push(
          `VIOLATION: ${filePath}:${lineNum} — \`as any\` detected. See docs/golden-principles.local.md #5`,
        );
      }

      // #5: No @ts-ignore or @ts-expect-error
      if (/@ts-ignore|@ts-expect-error/.test(line)) {
        violations.push(
          `VIOLATION: ${filePath}:${lineNum} — type suppression directive detected. See docs/golden-principles.local.md #5`,
        );
      }

      // #5: No empty catch blocks (checked via whole-source regex after loop)
    }

    // #5: No empty catch blocks (multi-line aware)
    const emptyCatchPattern = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/gm;
    let emptyCatchMatch = emptyCatchPattern.exec(source);
    while (emptyCatchMatch !== null) {
      const catchLine = lineNumberForOffset(source, emptyCatchMatch.index);
      violations.push(
        `VIOLATION: ${filePath}:${catchLine} — empty catch block detected. See docs/golden-principles.local.md #5`,
      );
      emptyCatchMatch = emptyCatchPattern.exec(source);
    }

    // #7: No catch-all filenames
    const basename = filePath.split("/").pop() ?? "";
    if (/^(utils|helpers|common|service)\.tsx?$/.test(basename) && filePath.includes("/src/")) {
      violations.push(
        `VIOLATION: ${filePath} — catch-all filename detected. See docs/golden-principles.local.md #7`,
      );
    }
  }

  return violations;
}

const TRACKED_DOCS = [
  "AGENTS.md",
  "packages/protocol/AGENTS.md",
  "packages/agent/AGENTS.md",
  "packages/machines/AGENTS.md",
  "packages/channels/AGENTS.md",
];

const STALE_THRESHOLD = 50; // commits since last modification

async function gitOutput(args: readonly string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await commandOutput(["git", ...args]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim() || "no stderr"}`);
  }
  return stdout;
}

export async function checkDocFreshness(
  readHistory: (args: readonly string[]) => Promise<string> = gitOutput,
): Promise<string[]> {
  const warnings: string[] = [];

  for (const docPath of TRACKED_DOCS) {
    const file = Bun.file(docPath);
    if (!(await file.exists())) {
      warnings.push(`WARNING: tracked doc missing: ${docPath}`);
      continue;
    }

    try {
      // Empty hash means no git history (untracked or new file).
      const lastTouchHash = (await readHistory(["log", "-1", "--format=%H", "--", docPath])).trim();
      if (!lastTouchHash) continue;

      const commitsSince = Number.parseInt(
        (await readHistory(["rev-list", "--count", `${lastTouchHash}..HEAD`])).trim(),
        10,
      );

      if (commitsSince >= STALE_THRESHOLD) {
        warnings.push(
          `STALE: ${docPath} — last updated ${commitsSince} commits ago (threshold: ${STALE_THRESHOLD})`,
        );
      }
    } catch {
      warnings.push(`WARNING: doc freshness unavailable for ${docPath}`);
    }
  }

  return warnings;
}

/**
 * Proves the layer rules discriminate, on synthetic inputs only — it reads no
 * package and writes nothing.
 *
 * `srcAllowedDeps` is the reason this exists: a rule that narrows `src/` below
 * the manifest can be deleted and every gate stays green, because the thing it
 * forbids is exactly the thing the manifest still permits. That is the shape
 * of a decorative gate, which is what this file is supposed to prevent.
 */
function selfTest(): number {
  const twoTier: PackageRule = {
    displayName: "self-test",
    packageJsonPath: "",
    packageName: "@openomni/self-test",
    allowedDeps: new Set(["@openomni/protocol", "@openomni/agent"]),
    srcAllowedDeps: new Set(["@openomni/protocol"]),
  };
  const oneTier: PackageRule = { ...twoTier, srcAllowedDeps: undefined };
  const anyExceptSelf: PackageRule = { ...twoTier, allowedDeps: "any-except-self" };
  const cases: Array<[string, boolean]> = [
    ["manifest permits what the manifest lists", isAllowedDep(twoTier, "@openomni/agent")],
    ["open workspace band rejects its own package", !isAllowedDep(anyExceptSelf, "@openomni/self-test")],
    ["open workspace band permits another package", isAllowedDep(anyExceptSelf, "@openomni/agent")],
    ["src refuses what only the manifest lists", !isAllowedSourceDep(twoTier, "@openomni/agent")],
    ["src permits its own narrower set", isAllowedSourceDep(twoTier, "@openomni/protocol")],
    ["src refuses what neither lists", !isAllowedSourceDep(twoTier, "@openomni/machines")],
    [
      "no srcAllowedDeps falls back to the manifest",
      isAllowedSourceDep(oneTier, "@openomni/agent"),
    ],
    ["external packages are never layered", isAllowedSourceDep(twoTier, "zod")],
    [
      "S8: a channels driver may not import the agent",
      isChannelsBandingViolation(
        "packages/channels/src/provider/discord/surface.ts",
        "@openomni/agent",
      ),
    ],
    [
      "S8: channels authn (perimeter judgment) may import the agent gate",
      !isChannelsBandingViolation("packages/channels/src/authn/decision.ts", "@openomni/agent"),
    ],
    [
      "S8: drivers keep the whitelisted contract deps",
      !isChannelsBandingViolation(
        "packages/channels/src/provider/discord/surface.ts",
        "@openomni/protocol",
      ),
    ],
    [
      "S8: the banding rule scopes to the channels package only",
      !isChannelsBandingViolation("apps/openomni/src/gateway.ts", "@openomni/agent"),
    ],
    [
      "S8: the gateway router may import the agent",
      !isChannelsBandingViolation(
        "packages/channels/src/router/routing-resolution.ts",
        "@openomni/agent",
      ),
    ],
    [
      "S8: the channel store band may import the agent persistence seams",
      !isChannelsBandingViolation("packages/channels/src/store/actor/index.ts", "@openomni/agent"),
    ],
    [
      "S8: a driver may not relative-import into src/router/",
      isChannelsDriverRouterEdge(
        "packages/channels/src/provider/discord/surface.ts",
        "../../router/index.js",
      ),
    ],
    [
      "S8: channel-authn (driver band) may not reach the router",
      isChannelsDriverRouterEdge(
        "packages/channels/src/channel-authn.ts",
        "./router/routing-resolution.js",
      ),
    ],
    [
      "S8: the package barrel may export the router (composition surface)",
      !isChannelsDriverRouterEdge("packages/channels/src/index.ts", "./router/index.js"),
    ],
    [
      "S8: router-internal relative imports stay legal",
      !isChannelsDriverRouterEdge(
        "packages/channels/src/router/routing-execution.ts",
        "./request/correlation.js",
      ),
    ],
    [
      "S8: drivers may still import the authn judgment entry",
      !isChannelsDriverRouterEdge("packages/channels/src/channel-authn.ts", "./authn/github.js"),
    ],
    [
      "S8: the router may name the permission evaluator",
      channelsAgentSurfaceViolations(
        "packages/channels/src/router/authority.ts",
        'import { evaluatePermission } from "@openomni/agent";',
      ).length === 0,
    ],
    [
      "S8: the router may name the scoped decision-fact port (#930)",
      channelsAgentSurfaceViolations(
        "packages/channels/src/router/stores.ts",
        'import { createDecisionFactPort } from "@openomni/agent";',
      ).length === 0,
    ],
    [
      "S8: the router may not name a brain agent surface",
      channelsAgentSurfaceViolations(
        "packages/channels/src/router/routing-resolution.ts",
        'import { openSessionStore, PolicyEvaluationInput } from "@openomni/agent";',
      ).length === 1,
    ],
    [
      "S8: the store band may name the persistence seams",
      channelsAgentSurfaceViolations(
        "packages/channels/src/store/actor/index.ts",
        'import { requireSubAdapter, withStoreTimestamps } from "@openomni/agent";',
      ).length === 0,
    ],
    [
      "S8: the store band may not name the gate",
      channelsAgentSurfaceViolations(
        "packages/channels/src/store/actor/index.ts",
        'import { evaluatePermission } from "@openomni/agent";',
      ).length === 1,
    ],
    [
      "S8: a type-only brain-surface import is still pinned",
      channelsAgentSurfaceViolations(
        "packages/channels/src/router/authority.ts",
        `import type { ${["Catalog", "Store"].join("")} } from "@openomni/agent";`,
      ).length === 1,
    ],
    [
      "S8: a namespace agent import cannot bypass the surface pin",
      channelsAgentSurfaceViolations(
        "packages/channels/src/router/actor-resolver.ts",
        'import * as Agent from "@openomni/agent";',
      ).length === 1,
    ],
    [
      "S8: the agent surface pin scopes to the channels bands",
      channelsAgentSurfaceViolations(
        "apps/openomni/src/gateway.ts",
        'import { openSessionStore } from "@openomni/agent";',
      ).length === 0,
    ],
    [
      "S8: a dynamic agent import cannot bypass the surface pin",
      channelsAgentSurfaceViolations(
        "packages/channels/src/router/routing-resolution.ts",
        'const agent = await import("@openomni/agent");',
      ).length === 1,
    ],
    [
      "S8: a require of the agent cannot bypass the surface pin",
      channelsAgentSurfaceViolations(
        "packages/channels/src/router/actor-resolver.ts",
        'const agent = require("@openomni/agent");',
      ).length === 1,
    ],
    [
      "S8: a dynamic agent SUBPATH import is pinned too",
      channelsAgentSurfaceViolations(
        "packages/channels/src/router/index.ts",
        'const s = await import("@openomni/agent/store");',
      ).length === 1,
    ],
    [
      "S8: a brain-surface re-export cannot launder past the pin",
      channelsAgentSurfaceViolations(
        "packages/channels/src/router/index.ts",
        'export { openCatalogStore } from "@openomni/agent";',
      ).length === 1,
    ],
    [
      "S8: a perimeter-surface re-export stays legal",
      channelsAgentSurfaceViolations(
        "packages/channels/src/router/index.ts",
        'export { createDecisionFactPort } from "@openomni/agent";',
      ).length === 0,
    ],
    [
      "S8: retired independent authority cannot regain a perimeter allowance",
      channelsAgentSurfaceViolations(
        "packages/channels/src/router/index.ts",
        `import { ${["Wait", "Store"].join("")} } from "@openomni/agent";`,
      ).length === 1,
    ],
    [
      "S8: the channels judgment band may not name the Journal ports",
      channelsAgentSurfaceViolations(
        "packages/channels/src/router/index.ts",
        'import { Journal } from "@openomni/agent";',
      ).length === 1,
    ],
    [
      "#1276: a core file may not import plugins/ (check a)",
      agentBandViolations(
        "packages/agent/src/core/evil.ts",
        'import { restore } from "../plugins/compaction/restore";',
      ).length === 1,
    ],
    [
      "#1276: a core file may not import inspect/ or testing/",
      agentBandViolations(
        "packages/agent/src/core/evil.ts",
        'import { fold } from "../inspect/history";\nimport { t } from "../testing/registry";',
      ).length === 2,
    ],
    [
      "#1276: a core file may not name ambient authority",
      agentBandViolations("packages/agent/src/core/evil.ts", "const t = Date.now();").length ===
        1,
    ],
    [
      "#1276: core-internal imports are legal (one core)",
      agentBandViolations(
        "packages/agent/src/core/run.ts",
        'import { x } from "./turn";\nimport { y } from "./store/fence";\nimport { z } from "./gate/decide";',
      ).length === 0,
    ],
    [
      "#1276: inspect/ reads the core but never the live bus",
      agentBandViolations(
        "packages/agent/src/inspect/history.ts",
        'import { k } from "../core/entity";\nimport { bus } from "../core/bus";',
      ).length === 1,
    ],
    [
      "#1276: a plugin may import core/api.ts (the one plugin surface)",
      agentBandViolations(
        "packages/agent/src/plugins/compaction/restore.ts",
        'import { Entropy } from "../../core/api";',
      ).length === 0,
    ],
    [
      "#1276: a plugin may not import any other core path (check b)",
      agentBandViolations(
        "packages/agent/src/plugins/compaction/evil.ts",
        'import { fence } from "../../core/store/fence";',
      ).length === 1,
    ],
    [
      "#1276: a plugin may not import a sibling plugin (check b)",
      agentBandViolations(
        "packages/agent/src/plugins/alarm/index.ts",
        'import { cut } from "../compaction/cut";',
      ).length === 1,
    ],
    [
      "#1276: a plugin may import inside itself",
      agentBandViolations(
        "packages/agent/src/plugins/compaction/compact.ts",
        'import { cut } from "./cut";\nimport { g } from "../compaction/geometry";',
      ).length === 0,
    ],
    [
      "#1276: model/ may not deep-import the core",
      agentBandViolations(
        "packages/agent/src/model/errors.ts",
        'import { fail } from "../core/failure";',
      ).length === 1,
    ],
    [
      "#1276 (r2): model/ may not import the core band root barrel either",
      agentBandViolations(
        "packages/agent/src/model/errors.ts",
        'import { Core } from "../core";',
      ).length === 1,
    ],
    [
      "#1276: testing/ may import anything in the package",
      agentBandViolations(
        "packages/agent/src/testing/registry.ts",
        'import { run } from "../core/run";\nimport { k } from "../core/turn";',
      ).length === 0,
    ],
    [
      "#1276: the band rules scope to packages/agent/src",
      agentBandViolations("apps/openomni/src/runtime.ts", "const t = Date.now();").length === 0,
    ],
    [
      "#1276: an app may not deep-import @openomni/agent (check c)",
      appsAgentInternalViolations(
        "apps/openomni/src/runtime.ts",
        'import { x } from "@openomni/agent/core/turn";',
      ).length === 1,
    ],
    [
      "#1276: an app may not relative-import into packages/agent/src (check c)",
      appsAgentInternalViolations(
        "apps/openomni/src/runtime.ts",
        'import { x } from "../../../packages/agent/src/core/turn";',
      ).length === 1,
    ],
    [
      "#1276: the app keeps the barrel and its own relative imports (check c)",
      appsAgentInternalViolations(
        "apps/openomni/src/runtime.ts",
        'import { Core } from "@openomni/agent";\nimport { x } from "./composition/model-selection";',
      ).length === 0,
    ],
    [
      "S8: a wholesale agent re-export is refused",
      channelsAgentSurfaceViolations(
        "packages/channels/src/router/index.ts",
        'export * from "@openomni/agent";',
      ).length === 1,
    ],
  ];

  const failed = cases.filter(([, ok]) => !ok).map(([name]) => name);
  for (const name of failed) console.error(`SELF-TEST FAILED: ${name}`);
  if (failed.length > 0) return 1;
  console.log(`OK: check-deps self-test — ${cases.length} layer discriminations hold`);
  return 0;
}

export async function main(): Promise<void> {
  assertTopologyComplete();
  if (Bun.argv.includes("--self-test")) {
    process.exitCode = selfTest();
    return;
  }
  const depViolations = await validateDependencyDirection();
  const sourceImportViolations = await validateSourceImportDirection();
  const channelsBandingViolations = await validateChannelsIntraPackageBanding();
  const agentBandViolationList = await validateAgentBands();
  const agentIndexPerimeterViolationList = await validateAgentIndexPerimeter();
  const appsAgentBarrelViolationList = await validateAppsAgentBarrel();
  const appAgentResponsibilityViolations = await validateAppAgentResponsibilities();
  const bundleViolations = await checkBundleImports();
  const deepImportViolations = await validateDeepImports();
  const deepRelativeImportViolations = await validateDeepRelativeImports();
  const goldenViolations = await validateGoldenPrinciples();
  const freshnessWarnings = await checkDocFreshness();
  const violations = [
    ...depViolations,
    ...sourceImportViolations,
    ...channelsBandingViolations,
    ...agentBandViolationList,
    ...agentIndexPerimeterViolationList,
    ...appsAgentBarrelViolationList,
    ...appAgentResponsibilityViolations,
    ...bundleViolations.map(
      (finding) => `VIOLATION: ${finding.code} ${finding.file}:${finding.line}`,
    ),
    ...deepImportViolations,
    ...deepRelativeImportViolations,
    ...goldenViolations,
  ];

  // #1276: tight pins — the printed total is the computed pin sum (= HEAD
  // actual); the historical reconciliation lives in the #1276 receipt.
  console.log(`#1276 agent band ratchet total: ${agentBandRatchetTotal()}`);

  // Print freshness warnings (non-blocking)
  for (const warning of freshnessWarnings) {
    console.warn(warning);
  }

  if (violations.length === 0 && freshnessWarnings.length === 0) {
    console.log(
      "OK: dependency direction, import boundaries, golden principles, and doc freshness are valid",
    );
    process.exitCode = 0;
    return;
  }

  if (violations.length === 0 && freshnessWarnings.length > 0) {
    console.log(`OK: no violations, but ${freshnessWarnings.length} stale doc(s) detected`);
    process.exitCode = 0;
    return;
  }

  for (const violation of violations) {
    console.error(violation);
  }

  process.exitCode = 1;
}

if (import.meta.main) await runScriptMain(main);
