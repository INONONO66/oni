import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";
import { decodeJson as strictJson } from "./quality-json";
import { qualitySource } from "./quality-source";
import type { TypescriptMetricContract } from "./quality-typescript-metrics";
import { assertTopologyComplete } from "./topology";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
// CLI failures are closed, typed records; native Error.cause is not our payload.
export class InventoryError {
  readonly name = "InventoryError";
  constructor(
    readonly code: string,
    readonly path: string,
    readonly message: string,
  ) {}
}
export function jsonObject(
  value: Json | undefined,
  keys?: readonly string[],
): { [key: string]: Json } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InventoryError("schema", "", "expected object");
  if (keys && Object.keys(value).some((key) => !keys.includes(key)))
    throw new InventoryError("schema", "", "unexpected object key");
  return value;
}
export function jsonString(value: Json | undefined): string {
  if (typeof value !== "string") throw new InventoryError("schema", "", "expected string");
  return value;
}
export function jsonNumber(value: Json | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new InventoryError("schema", "", "expected finite number");
  return value;
}
export function jsonBoolean(value: Json | undefined): boolean {
  if (typeof value !== "boolean") throw new InventoryError("schema", "", "expected boolean");
  return value;
}
export function jsonLiteral<T extends string | number>(value: Json | undefined, expected: T): T {
  if (value !== expected) throw new InventoryError("schema", "", "unexpected literal");
  return expected;
}
export function jsonChoice<T extends string>(value: Json | undefined, choices: readonly T[]): T {
  for (const choice of choices) if (value === choice) return choice;
  throw new InventoryError("schema", "", "unexpected choice");
}
export function jsonArray<T>(value: Json | undefined, parse: (entry: Json) => T): T[] {
  if (!Array.isArray(value)) throw new InventoryError("schema", "", "expected array");
  return value.map((entry) => parse(entry));
}
function relativePath(value: Json | undefined): string {
  const path = jsonString(value);
  if (!path || path.startsWith("/") || path.split("/").includes("..") || path.includes("\\"))
    throw new InventoryError("schema", "", "expected relative path");
  return path;
}
function metricContract(value: Json | undefined): TypescriptMetricContract {
  const object = jsonObject(value, [
    "algorithm",
    "tool",
    "version",
    "coverage",
    "cyclomaticExclusiveMax",
    "halsteadDifficultyExclusiveMax",
    "crapExclusiveMax",
  ]);
  const thresholds = {
    cyclomaticExclusiveMax: jsonNumber(object.cyclomaticExclusiveMax),
    halsteadDifficultyExclusiveMax: jsonNumber(object.halsteadDifficultyExclusiveMax),
    crapExclusiveMax: jsonNumber(object.crapExclusiveMax),
  };
  if (Object.values(thresholds).some((threshold) => !Number.isInteger(threshold) || threshold <= 0))
    throw new InventoryError("schema", "", "invalid metric threshold");
  return {
    algorithm: jsonLiteral(object.algorithm, "oni-typescript-function-metrics-v1"),
    tool: jsonLiteral(object.tool, "typescript"),
    version: jsonLiteral(object.version, "5.9.2"),
    coverage: jsonLiteral(object.coverage, "lcov-da-line-fraction-v1"),
    ...thresholds,
  };
}
export const contractSchema = {
  parse(value: Json) {
    const object = jsonObject(value, [
      "version",
      "typescript",
      "roots",
      "projects",
      "topology",
      "metrics",
    ]);
    const contract = {
      version: jsonLiteral(object.version, 1),
      typescript: jsonLiteral(object.typescript, "5.9.2"),
      roots: jsonArray(object.roots, relativePath),
      projects: jsonArray(object.projects, relativePath),
      topology: jsonBoolean(object.topology),
      ...(object.metrics === undefined ? {} : { metrics: metricContract(object.metrics) }),
    };
    if (
      !contract.roots.length ||
      !contract.projects.length ||
      (contract.topology && [...contract.roots].sort().join(",") !== "apps,packages,script")
    )
      throw new InventoryError("schema", "", "invalid ownership contract");
    return contract;
  },
};
export function parseEntry(value: Json) {
  const object = jsonObject(value, ["path", "sha256", "bytes", "category", "language"]);
  const sha256 = jsonString(object.sha256);
  const bytes = jsonNumber(object.bytes);
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isInteger(bytes) || bytes < 0)
    throw new InventoryError("schema", "", "invalid content identity");
  return {
    path: relativePath(object.path),
    sha256,
    bytes,
    category: jsonChoice(object.category, [
      "production",
      "tooling",
      "test",
      "fixture",
      "benchmark",
      "migration",
      "historical",
    ]),
    language: jsonChoice(object.language, ["typescript", "javascript", "python", "sql"]),
  };
}
export const inventorySchema = {
  parse(value: Json) {
    const object = jsonObject(value, [
      "version",
      "contractHash",
      "files",
      "historical",
      "embedded",
      "configurations",
    ]);
    return {
      version: jsonLiteral(object.version, 1),
      contractHash: jsonString(object.contractHash),
      files: jsonArray(object.files, parseEntry),
      historical: jsonArray(object.historical, parseEntry),
      embedded: jsonArray(object.embedded, parseEntry),
      configurations: jsonArray(object.configurations, (entry) => {
        const config = jsonObject(entry);
        return { path: relativePath(config.path), sha256: jsonString(config.sha256) };
      }),
    };
  },
};
export const errorSchema = {
  parse(value: Json) {
    const object = jsonObject(value);
    return {
      code: jsonString(object.code),
      path: jsonString(object.path),
      message: jsonString(object.message),
      ...(object.project === undefined ? {} : { project: jsonString(object.project) }),
    };
  },
};
export type Contract = ReturnType<typeof contractSchema.parse>;
export type Inventory = ReturnType<typeof inventorySchema.parse>;
export type CensusError = ReturnType<typeof errorSchema.parse>;
export function digest(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}
export function decodeJson(text: string): Json {
  try {
    return strictJson(text);
  } catch {
    throw new InventoryError("config", "", "invalid JSON syntax");
  }
}
export function readContract(path: string): Contract {
  return contractSchema.parse(decodeJson(readFileSync(path, "utf8")));
}
export function cliOptions() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      root: { type: "string", default: process.cwd() },
      contract: { type: "string", default: "script/conformance/quality-contract.json" },
      inventory: { type: "string" },
      plan: { type: "string" },
    },
    strict: true,
  });
  return { root: resolve(values.root), contract: values.contract, inventory: values.inventory, plan: values.plan };
}
const skipped = new Set(["node_modules", "dist", "coverage", ".git", ".turbo"]);
const languages = new Map<string, Inventory["files"][number]["language"]>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".sql", "sql"],
]);
export function category(path: string): Inventory["files"][number]["category"] {
  const parts = path.split("/");
  if (path.endsWith(".sql")) return "migration";
  if (parts.some((part) => /fixtures?/.test(part))) return "fixture";
  if (parts.includes("bench") || /\.bench\./.test(path)) return "benchmark";
  if (
    parts.includes("test") ||
    /\.(test|spec)\./.test(path) ||
    /(?:^|\/)(?:test_.+|.+_test)\.py$/.test(path)
  )
    return "test";
  if (parts.includes("script") || parts.includes("npm")) return "tooling";
  if (qualitySource(path)) return "production";
  if (/\.config\./.test(path)) return "tooling";
  return "production";
}
function collect(
  root: string,
  directory: string,
  inventory: Pick<Inventory, "files" | "configurations">,
): void {
  for (const name of readdirSync(directory).sort()) {
    if (skipped.has(name)) continue;
    const absolute = join(directory, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink())
      throw new InventoryError(
        "inventory",
        relative(root, absolute),
        "source symlink needs explicit ownership",
      );
    if (stat.isDirectory()) {
      collect(root, absolute, inventory);
      continue;
    }
    // Package manifests decide how bare specifiers resolve inside the owned
    // tree, so they are frozen with the compiler configurations.
    if (/^tsconfig.*\.json$/.test(name) || name === "package.json")
      inventory.configurations.push({
        path: relative(root, absolute),
        sha256: digest(readFileSync(absolute)),
      });
    const language = languages.get(extname(name));
    if (!language) continue;
    const path = relative(root, absolute);
    const bytes = readFileSync(absolute);
    inventory.files.push({
      path,
      sha256: digest(bytes),
      bytes: bytes.length,
      category: category(path),
      language,
    });
  }
}
function collectHistorical(
  root: string,
  contract: Contract,
  configurations: Inventory["configurations"],
  files: Inventory["files"],
): Inventory["historical"] {
  const historical: Inventory["historical"] = [];
  if (!contract.topology) return historical;
  const missingProjects = configurations.filter(
    (file) =>
      /\/tsconfig[^/]*\.json$/.test(file.path) &&
      !file.path.split("/").some((part) => /fixtures?/.test(part)) &&
      !contract.projects.includes(file.path) &&
      !/\/test\/tsconfig\.json$/.test(file.path),
  );
  if (missingProjects.length)
    throw new InventoryError(
      "inventory",
      "",
      `unregistered projects: ${missingProjects.map((file) => file.path).join(", ")}`,
    );
  const git = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (git.exitCode !== 0) throw new InventoryError("inventory", "", git.stderr.toString());
  for (const path of git.stdout.toString().split("\0")) {
    const language = languages.get(extname(path));
    if (!language || files.some((file) => file.path === path)) continue;
    // Git lists tracked paths even after an unstaged deletion; the
    // inventory records the working tree, so vanished files are skipped.
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue;
    const bytes = readFileSync(absolute);
    historical.push({
      path,
      sha256: digest(bytes),
      bytes: bytes.length,
      category: "historical",
      language,
    });
  }
  historical.sort((a, b) => compareText(a.path, b.path));
  return historical;
}

export function buildInventory(root: string, contract: Contract): Inventory {
  if (contract.topology) assertTopologyComplete(undefined, root);
  const files: Inventory["files"] = [];
  const configurations: Inventory["configurations"] = [];
  const embedded: Inventory["embedded"] = [];
  for (const directory of contract.roots)
    collect(root, resolve(root, directory), { files, configurations });
  // The root manifest is the package scope of every owned file without a
  // nearer one: its `imports` map and self-reference route bare specifiers.
  if (existsSync(join(root, "package.json")) && !configurations.some((c) => c.path === "package.json"))
    configurations.push({
      path: "package.json",
      sha256: digest(readFileSync(join(root, "package.json"))),
    });
  if (contract.topology) {
    configurations.push({
      path: "tsconfig.base.json",
      sha256: digest(readFileSync(join(root, "tsconfig.base.json"))),
    });
    const path = "packages/codemode/src/kernel.ts";
    const source = ts.createSourceFile(
      path,
      readFileSync(join(root, path), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node): void {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "PYTHON_DRIVER"
      ) {
        const init = node.initializer;
        if (
          !init ||
          !ts.isTaggedTemplateExpression(init) ||
          init.tag.getText(source) !== "String.raw" ||
          !ts.isNoSubstitutionTemplateLiteral(init.template)
        )
          throw new InventoryError("inventory", path, "unsupported embedded driver representation");
        const text = init.template.rawText;
        if (text === undefined)
          throw new InventoryError("inventory", path, "missing raw template text");
        embedded.push({
          path: `${path}#PYTHON_DRIVER`,
          sha256: digest(text),
          bytes: Buffer.byteLength(text),
          category: "production",
          language: "python",
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (embedded.length !== 1)
      throw new InventoryError("inventory", path, "embedded driver not uniquely inventoried");
  }
  configurations.sort((a, b) => compareText(a.path, b.path));
  files.sort((a, b) => compareText(a.path, b.path));
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new InventoryError("inventory", "", "overlapping source inventory");
  // Tracked historical evidence is recorded separately, never credited as product code.
  const historical = collectHistorical(root, contract, configurations, files);
  return {
    version: 1,
    contractHash: digest(JSON.stringify(contract)),
    files,
    historical,
    embedded,
    configurations,
  };
}
export function compareText(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}
export function verifyInventory(actual: Inventory, expected: Inventory): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new InventoryError(
      "inventory_drift",
      "",
      "source membership, hash, category or contract differs from frozen inventory",
    );
}
export function inventoryMain(): number {
  try {
    const options = cliOptions();
    const actual = buildInventory(
      options.root,
      readContract(resolve(options.root, options.contract)),
    );
    if (options.inventory)
      verifyInventory(
        actual,
        inventorySchema.parse(
          decodeJson(readFileSync(resolve(options.root, options.inventory), "utf8")),
        ),
      );
    console.log(JSON.stringify(actual));
    return 0;
  } catch {
    console.error(JSON.stringify({ code: "inventory", complete: false }));
    return 2;
  }
}
if (import.meta.main) process.exitCode = inventoryMain();
