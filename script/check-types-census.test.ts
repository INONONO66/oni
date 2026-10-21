import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInventory, decodeJson, inventorySchema, readContract } from "./quality-inventory";
import { census, resultSchema } from "./check-types-census";

function run(files: Record<string, string>, mutate?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "oni-census-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    if (!files["tsconfig.json"])
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            jsx: "preserve",
            types: [],
          },
          include: ["**/*.ts", "**/*.tsx"],
        }),
      );
    if (!files["contract.json"])
      writeFileSync(
        join(root, "contract.json"),
        JSON.stringify({
          version: 1,
          typescript: "5.9.2",
          roots: ["."],
          projects: ["tsconfig.json"],
          topology: false,
        }),
      );
    const inventory = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "quality-inventory.ts"),
        "--root",
        root,
        "--contract",
        "contract.json",
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 30000 },
    );
    expect(inventory.exitCode).toBe(0);
    writeFileSync(
      join(root, "inventory.json"),
      JSON.stringify(inventorySchema.parse(decodeJson(inventory.stdout.toString()))),
    );
    mutate?.(root);
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "check-types-census.ts"),
        "--root",
        root,
        "--contract",
        "contract.json",
        "--inventory",
        "inventory.json",
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 30000 },
    );
    return {
      status: result.exitCode,
      output: resultSchema.parse(decodeJson(result.stdout.toString())),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const importMetaBoundary =
  "export {}; declare global { interface ImportMeta { directory: string; payload: unknown } }";
const importMetaFiles = (expression: string) => ({
  "node_modules/boundary/index.d.ts": importMetaBoundary,
  "a.ts": `import "boundary"; export const value = ${expression};`,
});

// Each case performs an inventory/census pair with independently bounded subprocesses.
test("import.meta directory data is measured", () => {
  const clean = run({
    "node_modules/boundary/index.d.ts": importMetaBoundary,
    "a.ts": 'import "boundary"; export const directory = import.meta.directory;',
  });
  expect(clean.status).toBe(0);
  expect(clean.output.violations).toEqual([]);
});

for (const expression of ["import.meta", "import.meta.payload"] as const) {
  test(`${expression} data is measured`, () => {
    const data = run(importMetaFiles(expression));
    expect(data.status).toBe(1);
    expect(data.output.complete).toBe(true);
    expect(data.output.violations.some((v) => v.symbol === "value" && v.kind === "unknown")).toBe(
      true,
    );
  }, 30000);
}

test("clean TSX, recursive generics, aliases and prose have no findings", () => {
  const result = run({
    "a.tsx": `// any unknown\nexport const text = "any unknown";\ninterface Link<T> { value: T; next?: Link<T> }\nexport const link: Link<string> = { value: text };\nexport function identity<T>(value: T): T { return value; }\n`,
  });
  expect(result.status).toBe(0);
  expect(result.output.complete).toBe(true);
  expect(result.output.violations).toEqual([]);
});

for (const [label, source, symbol, kind] of [
  ["explicit", "export const value: any = 1;", "value", "explicitAny"],
  ["inferred", 'export const value = JSON.parse("{}");', "value", "implicitAny"],
  [
    "nested",
    "export const value: Map<string, Promise<Array<any>>> = new Map();",
    "value",
    "implicitAny",
  ],
  ["alias", "type Alias = unknown; export let value: Alias;", "value", "unknown"],
  ["catch", "try { throw 1; } catch (value) { console.log(value); }", "value", "unknown"],
  [
    "member",
    "interface Box { deep: { value: unknown } } export declare const value: Box;",
    "value",
    "unknown",
  ],
  ["return", "export function value() { return JSON.parse('null'); }", "value", "implicitAny"],
  [
    "default",
    "type Box<T = unknown> = { value: T }; export declare const value: Box;",
    "value",
    "unknown",
  ],
] as const) {
  test(`isolated ${label} is rejected with semantic identity`, () => {
    const result = run({ "sample.ts": source });
    expect(result.status).toBe(1);
    expect(result.output.complete).toBe(true);
    expect(
      result.output.violations.some(
        (v) => v.path === "sample.ts" && v.symbol === symbol && v.kind === kind,
      ),
    ).toBe(true);
  });
}

test("TSX, test and gate files all participate and paths are bytewise sorted", () => {
  const result = run({
    "z.test.ts": "export let testValue: unknown;",
    "script/gate.ts": "export let gateValue: any;",
    "app.tsx": "export let jsxValue: unknown;",
  });
  expect(result.status).toBe(1);
  expect([...new Set(result.output.violations.map((v) => v.path))]).toEqual([
    "app.tsx",
    "script/gate.ts",
    "z.test.ts",
  ]);
});

test("external container and actual imported function result are not exempt", () => {
  for (const nested of ["unknown", "any"]) {
    const result = run({
      "node_modules/boundary/index.d.ts": `export interface Payload { nested: Array<${nested}> }\nexport declare function read(): Payload;`,
      "a.ts": 'import { read } from "boundary"; export const value = read();',
    });
    expect(result.status).toBe(1);
    expect(
      result.output.violations.some(
        (v) => v.symbol === "value" && v.kind === (nested === "any" ? "implicitAny" : "unknown"),
      ),
    ).toBe(true);
  }
});

const compilerImport = JSON.stringify(join(import.meta.dir, "../node_modules/typescript"));

for (const [label, declaration, kinds] of [
  [
    "class",
    "export declare class Payload { a: Array<unknown>; b: Array<any> }",
    ["unknown", "implicitAny"],
  ],
  [
    "nested class",
    "export declare class Inner { a: Array<unknown>; b: Array<any> } export interface Payload { inner: Inner }",
    ["unknown", "implicitAny"],
  ],
  ["mapped", 'export type Payload = { [K in "a" | "b"]: { nested: unknown } };', ["unknown"]],
  [
    "remapped brand",
    `import ts from ${compilerImport}; type Brand = Pick<ts.SourceFile, "_declarationBrand">; export type Payload = { [K in keyof Brand as "payload"]: Brand[K] };`,
    ["implicitAny"],
  ],
  [
    "picked brand",
    `import ts from ${compilerImport}; export type Payload = Pick<ts.SourceFile, "_declarationBrand">;`,
    ["implicitAny"],
  ],
] as const) {
  test(`actual external ${label} payload cannot escape data traversal`, () => {
    const result = run({
      "node_modules/boundary/index.d.ts": `${declaration} export declare function read(): Payload;`,
      "a.ts": 'import { read } from "boundary"; export const value = read();',
    });
    expect(result.status).toBe(1);
    expect(result.output.complete).toBe(true);
    expect(result.output.errors).toEqual([]);
    expect([...new Set(result.output.violations.map((v) => v.kind))].sort()).toEqual(
      [...kinds].sort(),
    );
    expect(result.output.violations.some((v) => v.symbol === "value")).toBe(true);
    expect(result.output.abiMetadata).toEqual([]);
  });
}

test("unused pinned compiler brands have a separate ABI ledger, not data findings", () => {
  const result = run({
    "a.ts": `import ts from ${compilerImport}; export function name(source: ts.SourceFile) { return source.fileName; }`,
  });
  expect(result.status).toBe(0);
  expect(result.output.complete).toBe(true);
  expect(result.output.violations).toEqual([]);
  expect(
    result.output.abiMetadata.some(
      (entry) =>
        entry.path === "a.ts" &&
        entry.declarationSymbol === "Declaration._declarationBrand" &&
        entry.dependency === "typescript@5.9.2" &&
        entry.declarationOffset === 197314 &&
        entry.declarationHash ===
          "bddc8143c3b0fe2a6462f9811d3b28ea422ffee80d75d3d97d65d6b69f583fad",
    ),
  ).toBe(true);
});

test("application and external brand lookalikes remain payload violations", () => {
  const result = run({
    "node_modules/boundary/index.d.ts": "export interface Declaration { _declarationBrand: any }",
    "a.ts":
      'import type { Declaration } from "boundary"; interface Local { _declarationBrand: unknown } export declare const local: Local; export declare const external: Declaration;',
  });
  expect(result.status).toBe(1);
  expect(result.output.violations.some((v) => v.symbol === "local" && v.kind === "unknown")).toBe(
    true,
  );
  expect(
    result.output.violations.some((v) => v.symbol === "external" && v.kind === "implicitAny"),
  ).toBe(true);
  expect(result.output.abiMetadata).toEqual([]);
});

test("accessed, returned and stored genuine compiler brand values remain violations", () => {
  const result = run({
    "a.ts": `import ts from ${compilerImport}; export function read(source: ts.SourceFile) { return source._declarationBrand; } export function store(source: ts.SourceFile) { const value = source["_localsContainerBrand"]; return { value }; }`,
  });
  expect(result.status).toBe(1);
  expect(result.output.complete).toBe(true);
  expect(
    result.output.violations.some((v) => v.symbol === "read" && v.kind === "implicitAny"),
  ).toBe(true);
  expect(
    result.output.violations.some((v) => v.symbol === "value" && v.kind === "implicitAny"),
  ).toBe(true);
  expect(result.output.abiMetadata.length).toBeGreaterThan(0);
});

for (const nested of ["any", "unknown"]) {
  test(`unused function property is not a call; invoked named ${nested} result is measured`, () => {
    const declarations = `export interface Payload { nested: Array<${nested}> } export interface API { read: () => Payload } export declare function api(): API;`;
    const unused = run({
      "node_modules/boundary/index.d.ts": declarations,
      "a.ts": 'import { api } from "boundary"; export const value = api();',
    });
    expect(unused.status).toBe(0);
    expect(unused.output.violations).toEqual([]);
    const called = run({
      "node_modules/boundary/index.d.ts": declarations,
      "a.ts": 'import { api } from "boundary"; export const value = api().read();',
    });
    expect(called.status).toBe(1);
    expect(called.output.complete).toBe(true);
    expect(
      called.output.violations.some(
        (v) => v.symbol === "value" && v.kind === (nested === "any" ? "implicitAny" : "unknown"),
      ),
    ).toBe(true);
  });
}

test("copied compiler declarations do not acquire installed symbol identity", () => {
  const result = run({
    "node_modules/typescript/package.json": JSON.stringify({ types: "lib/typescript.d.ts" }),
    "node_modules/typescript/lib/typescript.d.ts": readFileSync(
      join(import.meta.dir, "../node_modules/typescript/lib/typescript.d.ts"),
      "utf8",
    ),
    "a.ts":
      'import ts from "typescript"; export function name(source: ts.SourceFile) { return source.fileName; }',
  });
  expect(result.status).toBe(1);
  expect(result.output.complete).toBe(true);
  expect(result.output.abiMetadata).toEqual([]);
  expect(
    result.output.violations.some((v) => v.symbol === "source" && v.kind === "implicitAny"),
  ).toBe(true);
});

test("compiler module augmentation adds measured data without an ABI exemption", () => {
  const result = run({
    "a.ts": `import ts from ${compilerImport}; declare module ${compilerImport} { interface SourceFile { payload: { nested: unknown } } } export function name(source: ts.SourceFile) { return source.fileName; }`,
  });
  expect(result.status).toBe(1);
  expect(result.output.complete).toBe(true);
  expect(result.output.violations.some((v) => v.symbol === "source" && v.kind === "unknown")).toBe(
    true,
  );
  expect(result.output.violations.some((v) => v.kind === "implicitAny")).toBe(false);
  expect(result.output.abiMetadata.length).toBeGreaterThan(0);
});

test("native compiler parsed configuration raw data remains measured through an honest view", () => {
  const result = run({
    "a.ts": `import ts from ${compilerImport}; export const config: { options: ts.CompilerOptions } | undefined = ts.getParsedCommandLineOfConfigFile("tsconfig.json", {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });`,
  });
  expect(result.status).toBe(1);
  expect(result.output.complete).toBe(true);
  expect(
    result.output.violations.some((v) => v.symbol === "config" && v.kind === "implicitAny"),
  ).toBe(true);
  expect(result.output.abiMetadata.length).toBeGreaterThan(0);
});

test("external result traversal does not inspect unrelated namespace exports or methods", () => {
  const result = run({
    "node_modules/boundary/index.d.ts":
      "export interface Payload { nested: Array<unknown>; method(): any }\nexport declare function read(): Payload;\nexport declare const unrelated: { hidden: any };",
    "a.ts": 'import { read } from "boundary"; export const value = read();',
  });
  expect(result.status).toBe(1);
  expect(
    result.output.violations.filter((v) => v.path === "a.ts").every((v) => v.kind === "unknown"),
  ).toBe(true);
  expect(result.output.violations[0]?.kind).toBe("unknown");
});

for (const [code, mutate] of [
  [
    "inventory_drift",
    (root: string) => writeFileSync(join(root, "omitted.ts"), "export const hidden = 1;"),
  ],
  ["inventory_drift", (root: string) => rmSync(join(root, "sample.ts"))],
  ["inventory_drift", (root: string) => writeFileSync(join(root, "tsconfig.json"), "{")],
] as const) {
  test(`fails closed: ${code}`, () => {
    const result = run({ "sample.ts": "export const okay = 1;" }, mutate);
    expect(result.status).toBe(2);
    expect(result.output.complete).toBe(false);
    expect(result.output.errors.some((error) => error.code === code)).toBe(true);
  });
}

test("unresolved module produces analyzer error, not a false census success", () => {
  const result = run({
    "sample.ts": 'import { value } from "missing-package"; export const result = value;',
  });
  expect(result.status).toBe(2);
  expect(result.output.complete).toBe(false);
  expect(result.output.errors.some((error) => error.code === "typescript")).toBe(true);
  expect(result.output.violations).toEqual([]);
});

test("malformed project configuration is an analyzer error", () => {
  const result = run({ "sample.ts": "export const okay = 1;", "tsconfig.json": "{" });
  expect(result.status).toBe(2);
  expect(result.output.errors.some((error) => error.code === "config")).toBe(true);
});

for (const config of [
  { extends: "./missing.json", files: ["sample.ts"] },
  { compilerOptions: { notACompilerOption: true }, files: ["sample.ts"] },
]) {
  test("native configuration failures retain the structured analyzer exit", () => {
    const result = run({
      "sample.ts": "export const value = 1;",
      "tsconfig.json": JSON.stringify(config),
    });
    expect(result.status).toBe(2);
    expect(result.output.complete).toBe(false);
    expect(result.output.errors.some((error) => error.code === "config")).toBe(true);
  });
}

test("project extends, path mappings, JSX and excluded-source fallback are measured", () => {
  const result = run({
    "base.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "preserve",
        types: [],
      },
    }),
    "tsconfig.json": JSON.stringify({
      extends: "./base.json",
      compilerOptions: { baseUrl: ".", paths: { "@model": ["model.ts"] } },
      files: ["app.tsx", "model.ts"],
    }),
    "model.ts":
      "export type Model = string; declare global { namespace JSX { interface Element { text: string } interface IntrinsicElements { div: {} } } }",
    "app.tsx":
      'import type { Model } from "@model"; export const text: Model = "clean"; export const view = <div />;',
    "excluded.test.ts": "export const value: Array<unknown> = [];",
  });
  expect(result.status).toBe(1);
  expect(result.output.complete).toBe(true);
  expect(
    result.output.violations.some(
      (v) => v.path === "excluded.test.ts" && v.symbol === "value" && v.kind === "unknown",
    ),
  ).toBe(true);
  expect(result.output.violations.filter((v) => v.path === "app.tsx")).toEqual([]);
});

test("separate project compiler options are not flattened", () => {
  const result = run({
    "contract.json": JSON.stringify({
      version: 1,
      typescript: "5.9.2",
      roots: ["."],
      projects: ["tsconfig.json", "other/tsconfig.json"],
      topology: false,
    }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", types: [] },
      files: ["first.ts"],
    }),
    "other/tsconfig.json": JSON.stringify({
      extends: "../tsconfig.json",
      compilerOptions: { useUnknownInCatchVariables: false },
      files: ["second.ts"],
    }),
    "first.ts": "export {}; try { throw 1; } catch (first) { console.log(first); }",
    "other/second.ts": "export {}; try { throw 1; } catch (second) { console.log(second); }",
  });
  expect(result.status).toBe(1);
  expect(result.output.violations.some((v) => v.symbol === "first" && v.kind === "unknown")).toBe(
    true,
  );
  expect(
    result.output.violations.some((v) => v.symbol === "second" && v.kind === "implicitAny"),
  ).toBe(true);
});

test("unreferenced explicit type keywords still count", () => {
  const result = run({ "sample.ts": "export type Standalone = any;" });
  expect(result.status).toBe(1);
  expect(
    result.output.violations.some((v) => v.symbol === "Standalone" && v.kind === "explicitAny"),
  ).toBe(true);
});

test("TypeScript grammar names are not queried, while real controls remain measured", () => {
  const result = run({
    "grammar.ts": [
      "type Predicate = (value: unknown) => value is string;",
      "type Renamed = { source: unknown }; const { source: renamed } = {} as Renamed;",
      "type Tuple = [label: unknown];",
      "type Exported = unknown; export type { Exported }; export { type Exported as RenamedExport };",
      "namespace Namespaced { export const value = 1; }",
      `type Template = \`prefix-${String.fromCharCode(36)}{string}\`;`,
      "export const realAny: any = 1;",
      "export const realUnknown: unknown = 1;",
    ].join("\n"),
  });
  expect(result.status).toBe(1);
  expect(result.output.complete).toBe(true);
  expect(
    result.output.violations.some((v) => v.symbol === "realAny" && v.kind === "explicitAny"),
  ).toBe(true);
  expect(
    result.output.violations.some((v) => v.symbol === "realUnknown" && v.kind === "unknown"),
  ).toBe(true);
  expect(
    result.output.violations.some((v) => v.symbol === "Predicate" && v.kind === "implicitAny"),
  ).toBe(false);
  expect(
    result.output.violations.some((v) => v.symbol === "renamed" && v.kind === "implicitAny"),
  ).toBe(false);
  expect(
    result.output.violations.some((v) => v.symbol === "label" && v.kind === "implicitAny"),
  ).toBe(false);
  expect(
    result.output.violations.some((v) => v.symbol === "Exported" && v.kind === "implicitAny"),
  ).toBe(false);
  expect(
    result.output.violations.some((v) => v.symbol === "RenamedExport" && v.kind === "implicitAny"),
  ).toBe(false);
  expect(
    result.output.violations.some((v) => v.symbol === "Namespaced" && v.kind === "implicitAny"),
  ).toBe(false);
});

test("literal type grammar is not inferred any, while actual numeric values are measured", () => {
  const result = run({
    "literal.ts":
      'export type Receipt = { version: 1; failure: -1; bigint: 1n; text: "ready" }; export const version: Receipt["version"] = 1;\n',
  });
  expect(result.status).toBe(0);
  expect(result.output.complete).toBe(true);
  expect(result.output.violations).toEqual([]);
});

test("native TypeScript projects accept JSONC without weakening strict receipt JSON", () => {
  const result = run({
    "a.ts": "export const value = 1;",
    "tsconfig.json":
      '{\n// Native project comment\n"compilerOptions":{"strict":true,"noEmit":true},"include":["a.ts"],\n}\n',
  });
  expect(result.status).toBe(0);
  expect(result.output.complete).toBe(true);
  expect(result.output.errors).toEqual([]);
});

// In-process census: the same fixture layout as `run`, measured directly so
// origin attribution is exercised by this lane's own native coverage.
function measure(files: Record<string, string>, complete = true) {
  const root = mkdtempSync(join(tmpdir(), "oni-census-origin-"));
  try {
    for (const [path, text] of Object.entries({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          types: [],
        },
        include: ["**/*.ts"],
      }),
      "contract.json": JSON.stringify({
        version: 1,
        typescript: "5.9.2",
        roots: ["."],
        projects: ["tsconfig.json"],
        topology: false,
      }),
      ...files,
    })) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const contract = readContract(join(root, "contract.json"));
    const result = census(root, contract, buildInventory(root, contract));
    expect(result.complete).toBe(complete);
    expect(result.errors.length > 0).toBe(!complete);
    return result.violations.map((v) => `${v.kind}:${v.symbol}:${v.origin}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("top types are owned when written, declared or inferred in owned source, foreign when reached only through dependency declarations", () => {
  const found = measure({
    "node_modules/dep/index.d.ts": [
      "export interface Boxed<T> { value: T }",
      "export type Aliased<T> = { inner: T }",
      "export declare function make(): { nested: unknown; cause: any }",
      "export declare const loose: any;",
      "export declare function call(): unknown;",
      "export declare const dictionary: { [key: string]: unknown };",
      "export declare class Failure { readonly detail: unknown }",
      "export type Anything = unknown;",
    ].join("\n"),
    "a.ts": [
      'import { make, loose, call, dictionary, Failure, type Anything, type Boxed, type Aliased } from "dep";',
      "export const reached = make();",
      "export const direct = loose;",
      "export const called = loose();",
      "export const result = call();",
      "export const awaited = async () => await call();",
      "export const indexed = dictionary;",
      'export const element = dictionary["key"];',
      "export const failure = new Failure();",
      "export const viaAlias: Anything = 1;",
      "export const either: Own | Boxed<string> = { data: 1 };",
      "export const written: unknown = 1;",
      "export function own(parameter: unknown) { return parameter; }",
      "export const boxed: Boxed<unknown> = { value: 1 };",
      "export const aliased: Aliased<unknown> = { inner: 1 };",
      "export interface Own { data: unknown }",
      "export function use(value: Own) { return value.data; }",
      'export function pick<T extends Own>(item: T): T["data"] { return item.data; }',
      "export const inferred = JSON.parse('{}');",
      "try { throw 1; } catch (caught) { console.log(caught); }",
    ].join("\n"),
  });
  const of = (symbol: string) => [
    ...new Set(found.filter((f) => f.split(":")[1] === symbol).map((f) => f.split(":")[2])),
  ];
  for (const symbol of ["reached", "awaited", "indexed", "failure", "loose", "dictionary"])
    expect(of(symbol)).toEqual(["foreign"]);
  expect(found.filter((f) => f.includes(":element:"))).toEqual(["unknown:element:owned"]);
  // The foreign alias is the dependency's; the binding annotated with it is owned.
  expect(found.filter((f) => f.includes(":viaAlias:"))).toEqual([
    "unknown:viaAlias:owned",
    "unknown:viaAlias:foreign",
  ]);
  expect(of("either")).toEqual(["owned"]);
  for (const symbol of ["written", "own", "parameter", "use", "value", "caught", "Own", "data"])
    expect(of(symbol)).toEqual(["owned"]);
  // A binding that stores a directly top-typed foreign result without narrowing is owned;
  // the producing expression is the dependency's.
  expect(found.filter((f) => f.includes(":direct:"))).toEqual(["implicitAny:direct:owned"]);
  expect(found.filter((f) => f.includes(":called:"))).toEqual([
    "implicitAny:called:owned",
    "implicitAny:called:foreign",
  ]);
  expect(of("pick")).toEqual(["owned"]);
  expect(found.filter((f) => f.includes(":result:"))).toEqual([
    "unknown:result:owned",
    "unknown:result:foreign",
  ]);
  expect(found.filter((f) => f.includes(":inferred:"))).toEqual([
    "implicitAny:inferred:owned",
    "implicitAny:inferred:foreign",
  ]);
  // A written `unknown` argument of a foreign generic is owned once (the keyword); its propagation is the dependency's.
  for (const symbol of ["boxed", "aliased"]) {
    expect(found.filter((f) => f === `unknown:${symbol}:owned`)).toHaveLength(1);
    expect(found.filter((f) => f === `unknown:${symbol}:foreign`)).toHaveLength(2);
  }
  // Mutation: owning the declaration flips every reach to owned.
  const owned = measure({
    "b.ts":
      "export interface Boxed<T> { value: T }\nexport function make(): { nested: unknown } { return { nested: 1 }; }\nexport const reached = make();\nexport const boxed: Boxed<unknown> = { value: 1 };",
  });
  expect(owned.filter((f) => f.startsWith("unknown:reached:"))).toEqual([
    "unknown:reached:owned",
    "unknown:reached:owned",
  ]);
  expect(owned.filter((f) => f.startsWith("unknown:boxed:"))).toHaveLength(3);
  expect(owned.some((f) => f.endsWith(":foreign"))).toBe(false);
  // Compiler ABI brands stay measured metadata, attributed like any other reach.
  const compiler = measure({
    "a.ts": `import ts from ${compilerImport}; declare module ${compilerImport} { interface SourceFile { payload: { nested: unknown } } } export function name(source: ts.SourceFile) { return source.fileName; }`,
  });
  expect(compiler.filter((f) => f.includes(":source:"))).toEqual([
    "unknown:source:owned",
    "unknown:source:owned",
  ]);
  // An unresolved project measures nothing, so it attributes nothing.
  expect(
    measure(
      { "u.ts": 'import { value } from "missing-package"; export const result = value;' },
      false,
    ),
  ).toEqual([]);
});
