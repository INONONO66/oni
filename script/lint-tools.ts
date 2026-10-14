/**
 * Kernel-contract conformance gate — P0 increments (#467).
 *
 * Checks (numbering follows the issue):
 *   1. vocab-ratchet     protocol namespace ↔ core-model Tier-1/2 noun (injective),
 *                        grandfathered baseline + no-new-violations ratchet
 *   2. tool-lint         LLM tool surface: snake_case ≤3 segments, description
 *                        required, ≤7 public input fields; protocol naming rules
 *                        (banned nouns, no *Module wrappers) with the same ratchet
 *   6. earned-check      every dispatch action constant / registered tool has ≥1
 *                        non-definition production reference, or is baselined
 *   7. schema-snapshot   Greg Young lint: no field disappears/renames on existing
 *                        protocol event/schema types; new types and added fields
 *                        pass; `--update` regenerates the snapshot (Owner-review
 *                        moment)
 *
 * Modes:
 *   bun run script/lint-tools.ts               run all checks
 *   bun run script/lint-tools.ts --update      regenerate schema snapshot
 *   bun run script/lint-tools.ts --self-test   discrimination bench: every check
 *                                              must flag its known-bad fixture
 *
 * The verifier registry and replay-conformance primitives land independently
 * under #467 while this P0 gate remains active. #493 owns archived
 * projection/replay integration.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runScriptMain } from "./main-runner";
import { agentSourceFacts, checkCoreEndState } from "./check-core-end-state";
import { projectTools } from "../packages/agent/src/core/loop/tool.js";
import { catalogDefinitions, type ToolPorts } from "../apps/openomni/src/bundles/tools/core/catalog.js";
import { createMonitorTool } from "../apps/openomni/src/bundles/alarms/monitor/index.js";
import { eraseTool } from "../packages/agent/src/core/loop/tool.js";
import type { Tool, AnyToolDefinition, ToolCategory } from "../packages/protocol/src/tool/index.js";
import type { PlainObject, PlainValue } from "../packages/protocol/src/json.js";
import { z } from "zod";
import { decodeJson } from "./quality-json";
import * as protocolExports from "../packages/protocol/src/index.js";

// Schema inspection never executes ports; absent capabilities are explicit test doubles.
const schemaPorts: ToolPorts = {
  messages: undefined, machines: undefined, cells: undefined,
  llm: undefined, provisioning: undefined, clock: () => 0, id: () => "schema",
};
// #1308: `monitor` is bundle-declared; the lint surface stays the full 12 tools.
const definitions = [...catalogDefinitions(schemaPorts), eraseTool(createMonitorTool(() => undefined))];

/**
 * The snapshot pins the FULL catalog surface, cell-only doors included:
 * `projectTools(...).specs` drops model-invisible tools, so visibility is
 * widened for the projection alone (`Tool.Spec` carries no visibility).
 */
function allToolSpecs(list: readonly AnyToolDefinition[]): readonly Tool.Spec[] {
  return projectTools(
    list.map((definition) =>
      definition.visibility.model.length > 0
        ? definition
        : { ...definition, visibility: { ...definition.visibility, model: ["resident" as const] } },
    ),
  ).specs;
}

interface Violation {
  readonly check:
    | "vocab-ratchet"
    | "tool-lint"
    | "naming"
    | "earned-check"
    | "schema-snapshot"
    | "tool-schema-snapshot"
    | "core-end-state";
  readonly subject: string;
  readonly message: string;
}

export interface Baseline {
  readonly vocab: { readonly unmappedNamespaces: readonly string[] };
  // Absent when no tool needs an exception — an empty exceptions map cannot
  // be written without an added baseline line, so the key simply disappears.
  readonly tools?: { readonly exceptions: Readonly<Record<string, readonly string[]>> };
  readonly naming: { readonly grandfathered: readonly string[] };
}

type SchemaSnapshot = Readonly<Record<string, readonly string[]>>;

// Every path is anchored on the repository root, never on process.cwd(): sibling
// tests in the same bun shard chdir into fixtures, and the in-process checks
// must still find the catalog sources and conformance files.
const ROOT = join(import.meta.dir, "..");
const BASELINE_PATH = join(ROOT, "script/conformance/lint-tools-baseline.json");
const SNAPSHOT_PATH = join(ROOT, "script/conformance/schema-snapshot.json");
const TOOL_SNAPSHOT_PATH = join(ROOT, "script/conformance/tool-schema-snapshot.json");
const PROTOCOL_SRC = "packages/protocol/src";
const CORE_MODEL_PATH = join(ROOT, "docs/core-model.md");
const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".bench.ts"];

// ---------------------------------------------------------------------------
// check 1 — vocab ratchet
// ---------------------------------------------------------------------------

export function extractTierNouns(coreModelSource: string): Set<string> {
  const nouns = new Set<string>();
  const tierLines = coreModelSource
    .split("\n")
    .filter((line) => line.startsWith("**Tier 1") || line.startsWith("**Tier 2"));
  for (const line of tierLines) {
    const body = line.replace(/\*\*Tier \d[^*]*\*\*/, "");
    for (const match of body.matchAll(/[A-Z][A-Za-z]+/g)) {
      nouns.add(match[0]);
    }
  }
  return nouns;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[-_]/g, "");
}

export function unmappedNamespaces(
  namespaces: readonly string[],
  tierNouns: ReadonlySet<string>,
): string[] {
  const normalizedNouns = new Set(Array.from(tierNouns, normalizeToken));
  return namespaces.filter((namespace) => !normalizedNouns.has(normalizeToken(namespace)));
}

async function listProtocolNamespaces(): Promise<string[]> {
  const dirs = new Set<string>();
  const glob = new Bun.Glob(`${PROTOCOL_SRC}/*/index.ts`);
  for await (const filePath of glob.scan({ cwd: ROOT, onlyFiles: true })) {
    const segments = filePath.split("/");
    const dir = segments[segments.length - 2];
    if (dir) {
      dirs.add(dir);
    }
  }
  return Array.from(dirs).sort((a, b) => a.localeCompare(b));
}

export async function checkVocabRatchet(baseline: Baseline): Promise<Violation[]> {
  const namespaces = await listProtocolNamespaces();
  const tierNouns = extractTierNouns(readFileSync(CORE_MODEL_PATH, "utf8"));
  const unmapped = unmappedNamespaces(namespaces, tierNouns);
  const grandfathered = new Set(baseline.vocab.unmappedNamespaces);

  const violations: Violation[] = unmapped
    .filter((namespace) => !grandfathered.has(namespace))
    .map((namespace) => ({
      check: "vocab-ratchet" as const,
      subject: namespace,
      message:
        "new protocol namespace maps to no core-model Tier-1/2 noun (injective namespace→noun); " +
        "either name it after a vocabulary noun or get Owner sign-off on a core-model addition",
    }));

  for (const stale of baseline.vocab.unmappedNamespaces) {
    if (!unmapped.includes(stale)) {
      violations.push({
        check: "vocab-ratchet",
        subject: stale,
        message: "baseline entry no longer unmapped — shrink the baseline (ratchet only tightens)",
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// check 2 — tool lint + protocol naming rules
// ---------------------------------------------------------------------------

export interface ToolSurface {
  readonly name: string;
  readonly description: string | undefined;
  readonly inputSchema: PlainObject;
}

// #949 seals the catalog on snake_case (KERNEL §3.5); dot namespacing stays for protocol vocab.
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._][a-z][a-z0-9]*){0,2}$/;
// KERNEL §3.5 fixes grep at seven public fields (pattern, path, glob, ignoreCase, literal,
// context, limit); the budget is the sealed catalog's widest tool, not a spare allowance.
const MAX_PUBLIC_FIELDS = 7;

function localReference(
  root: PlainObject,
  reference: string,
): PlainObject | undefined {
  if (!reference.startsWith("#/")) return undefined;
  let value: PlainValue | undefined = root;
  for (const encoded of reference.slice(2).split("/")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    value = value[key];
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function combineFieldSets(
  left: readonly Set<string>[],
  right: readonly Set<string>[],
): Set<string>[] {
  return left.flatMap((a) => right.map((b) => new Set([...a, ...b])));
}

function topLevelFieldSets(
  schema: PlainObject,
  root: PlainObject,
  references: ReadonlySet<string> = new Set(),
): Set<string>[] {
  const own = new Set(
    Object.keys(
      typeof schema.properties === "object" &&
        schema.properties !== null &&
        !Array.isArray(schema.properties)
        ? schema.properties
        : {},
    ),
  );
  const reference = typeof schema.$ref === "string" ? schema.$ref : undefined;
  let sets: Set<string>[] = [own];
  if (reference !== undefined && !references.has(reference)) {
    const target = localReference(root, reference);
    if (target !== undefined) {
      sets = combineFieldSets(
        sets,
        topLevelFieldSets(target, root, new Set([...references, reference])),
      );
    }
  }
  for (const key of ["allOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (typeof branch === "object" && branch !== null && !Array.isArray(branch)) {
        sets = combineFieldSets(
          sets,
          topLevelFieldSets(branch, root, references),
        );
      }
    }
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    const variants = branches.flatMap((branch) =>
      typeof branch === "object" && branch !== null && !Array.isArray(branch)
        ? topLevelFieldSets(branch, root, references)
        : [],
    );
    if (variants.length > 0) sets = combineFieldSets(sets, variants);
  }
  return sets;
}

function topLevelFieldCount(schema: PlainObject): number {
  return Math.max(0, ...topLevelFieldSets(schema, schema).map((fields) => fields.size));
}

export interface ToolLintFailure {
  readonly rule: "tool-name" | "tool-description" | "tool-max-fields";
  readonly message: string;
}

export function lintToolSurface(tool: ToolSurface): ToolLintFailure[] {
  const failures: ToolLintFailure[] = [];
  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    failures.push({
      rule: "tool-name",
      message: "name must be snake_case (dot namespacing allowed), ≤3 segments",
    });
  }
  if (!tool.description || tool.description.trim().length === 0) {
    failures.push({ rule: "tool-description", message: "description is required" });
  }
  const maxFields = MAX_PUBLIC_FIELDS;
  if (topLevelFieldCount(tool.inputSchema) > maxFields) {
    failures.push({
      rule: "tool-max-fields",
      message: `public input schema exceeds ${maxFields} top-level fields`,
    });
  }
  // enum-over-free-string is not statically decidable from a JSON schema alone
  // (whether an axis *has* a finite vocabulary is a design fact) — reviewed, not linted.
  return failures;
}

function collectToolSurfaces(): ToolSurface[] {
  return allToolSpecs(definitions).map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
  }));
}

export async function checkToolLint(
  baseline: Baseline,
  surfaces: readonly ToolSurface[] = collectToolSurfaces(),
): Promise<Violation[]> {
  const violations: Violation[] = [];

  for (const surface of surfaces) {
    const exceptions = new Set(baseline.tools?.exceptions[surface.name] ?? []);
    for (const failure of lintToolSurface(surface)) {
      if (!exceptions.has(failure.rule)) {
        violations.push({
          check: "tool-lint",
          subject: surface.name,
          message: `[${failure.rule}] ${failure.message}`,
        });
      }
    }
  }

  return violations;
}

const BANNED_NOUN_PATTERN =
  /\b(?:export\s+(?:const|type|interface|class|enum|namespace))\s+([A-Za-z]*(?:Runtime|Task|Envelope)[A-Za-z]*|[A-Za-z]+Module)\b/g;

export function namingOffenders(filePath: string, source: string): string[] {
  const offenders = new Set<string>();
  for (const match of source.matchAll(BANNED_NOUN_PATTERN)) {
    offenders.add(`${filePath}:${match[1]}`);
  }
  return Array.from(offenders);
}

export function namingViolations(
  filePath: string,
  source: string,
  grandfathered: ReadonlySet<string>,
): Violation[] {
  return namingOffenders(filePath, source)
    .filter((offender) => !grandfathered.has(offender))
    .map((offender) => ({
      check: "naming",
      subject: offender,
      message:
        "new protocol identifier uses a banned noun (runtime/task/envelope) or a *Module wrapper name (#465 naming rules)",
    }));
}

export async function checkNaming(baseline: Baseline): Promise<Violation[]> {
  const grandfathered = new Set(baseline.naming.grandfathered);
  const violations: Violation[] = [];
  const glob = new Bun.Glob(`${PROTOCOL_SRC}/**/*.ts`);
  for await (const filePath of glob.scan({ cwd: ROOT, onlyFiles: true })) {
    if (TEST_SUFFIXES.some((suffix) => filePath.endsWith(suffix))) continue;
    const source = await Bun.file(join(ROOT, filePath)).text();
    violations.push(...namingViolations(filePath, source, grandfathered));
  }
  return violations;
}

// ---------------------------------------------------------------------------
// check 6 — earned check
// ---------------------------------------------------------------------------

// #1255: bundle-owned tools live under `src/bundles/<bundle>/index.ts`.
const TOOL_SOURCE_GLOBS = ["apps/openomni/src/bundles/tools/**/*.ts", "apps/openomni/src/bundles/**/*.ts"];
const TOOL_CATEGORIES: readonly ToolCategory[] = ["query", "mutation", "authority", "execution"];

function looksLikeToolDefinition(value: object): value is AnyToolDefinition {
  return z.object({
    name: z.string(),
    category: z.string(),
    description: z.string(),
    execute: z.function(),
    render: z.function(),
  }).safeParse(value).success;
}

export interface LocatedDefinition {
  readonly definition: AnyToolDefinition;
  readonly filePath: string;
}

export function recordToolLocation(
  located: Map<AnyToolDefinition, string>,
  definition: AnyToolDefinition,
  filePath: string,
): void {
  const previous = located.get(definition);
  if (previous !== undefined && previous !== filePath) {
    throw new Error(`tool ${definition.name} has ambiguous source: ${previous}, ${filePath}`);
  }
  located.set(definition, filePath);
}

async function locateExportedDefinitions(
  definitions: readonly AnyToolDefinition[],
): Promise<LocatedDefinition[]> {
  const located = new Map<AnyToolDefinition, string>();
  const files = new Set<string>();
  for (const pattern of TOOL_SOURCE_GLOBS) {
    for await (const filePath of new Bun.Glob(pattern).scan({ cwd: ROOT, onlyFiles: true })) {
      files.add(filePath);
    }
  }
  for (const filePath of files) {
    if (TEST_SUFFIXES.some((suffix) => filePath.endsWith(suffix))) continue;
    const source = await Bun.file(join(ROOT, filePath)).text();
    const module = z.record(z.string(), z.union([
      z.instanceof(Object), z.string(), z.number(), z.boolean(),
      z.bigint(), z.symbol(), z.null(), z.undefined(),
    ])).parse(createRequire(import.meta.url)(join(ROOT, filePath)));
    for (const value of Object.values(module)) {
      if (typeof value === "object" && value !== null && looksLikeToolDefinition(value))
        located.set(value, filePath);
    }
    for (const definition of definitions) {
      const escaped = definition.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const declaration = new RegExp(`(?:name\\s*:|=)\\s*["']${escaped}["']`);
      if (!declaration.test(source)) continue;
      recordToolLocation(located, definition, filePath);
    }
  }
  return Array.from(located, ([definition, filePath]) => ({ definition, filePath }));
}

/** KERNEL 3.5: `tools/<name>.ts`, with the repo's kebab-case file rule applied to snake_case names. */
function toolFileName(toolName: string): string {
  return `${toolName.replaceAll("_", "-")}.ts`;
}

/** #1255: a bundle-owned tool lives in its bundle's `index.ts`, directory named after the tool. */
function isToolSourcePath(toolName: string, filePath: string): boolean {
  const directory = toolName.replaceAll("_", "-");
  const bundleRelative = filePath.startsWith("apps/openomni/src/bundles/")
    ? filePath.slice("apps/openomni/src/bundles/".length).split("/")
    : [];
  const bundleLayout = (
    (bundleRelative.length === 2 && bundleRelative[1] === "index.ts") ||
    (bundleRelative.length === 3 && bundleRelative[2] === "index.ts")
  );
  return (
    filePath.endsWith(`/${toolFileName(toolName)}`) ||
    (bundleLayout && bundleRelative.at(-2) === directory)
  );
}

export function definitionInvariantViolations(
  definitions: readonly AnyToolDefinition[],
  located: readonly LocatedDefinition[],
): Violation[] {
  const violations: Violation[] = [];
  const catalog = new Set(definitions);
  const locations = new Map<AnyToolDefinition, string>();
  for (const item of located) {
    locations.set(item.definition, item.filePath);
    if (!catalog.has(item.definition)) {
      violations.push({
        check: "earned-check",
        subject: `${item.filePath}:${item.definition.name}`,
        message: "exported tool definition is not wired into catalogDefinitions",
      });
    }
  }

  const names = new Map<string, number>();
  for (const definition of definitions)
    names.set(definition.name, (names.get(definition.name) ?? 0) + 1);
  for (const definition of definitions) {
    const filePath = locations.get(definition);
    if (filePath === undefined) {
      violations.push({
        check: "tool-lint",
        subject: definition.name,
        message: "[tool-source-location] catalog definition has no verifiable source file",
      });
    } else if (!isToolSourcePath(definition.name, filePath)) {
      violations.push({
        check: "tool-lint",
        subject: definition.name,
        message: `[tool-file-name] tool must live in ${toolFileName(definition.name)} (KERNEL 3.5: file name is the tool name, kebab-case)`,
      });
    }
    if (!TOOL_CATEGORIES.includes(definition.category)) {
      violations.push({
        check: "tool-lint",
        subject: definition.name,
        message: `[tool-category] unknown category ${definition.category}`,
      });
    }
    if (definition.name.trim() === "") {
      violations.push({
        check: "tool-lint",
        subject: "<empty>",
        message: "[tool-name] name must not be empty",
      });
    }
    if (definition.description.trim() === "") {
      violations.push({
        check: "tool-lint",
        subject: definition.name,
        message: "[tool-description] description must not be empty",
      });
    }
    if ((names.get(definition.name) ?? 0) > 1) {
      violations.push({
        check: "tool-lint",
        subject: definition.name,
        message: "[tool-name-unique] tool names must be unique",
      });
    }
  }
  return violations;
}

export async function checkEarned(): Promise<Violation[]> {
  return definitionInvariantViolations(
    definitions,
    await locateExportedDefinitions(definitions),
  );
}

// ---------------------------------------------------------------------------
// check 7 — schema snapshot (Greg Young lint)
// ---------------------------------------------------------------------------

interface ZodObjectLike {
  readonly shape?: Readonly<Record<string, object>>;
  readonly options?: readonly object[];
  readonly safeParse: (...args: never[]) => object;
  readonly _def?: Readonly<Record<string, object | string>>;
  readonly value?: string;
}

function isZodSchema(value: object): value is ZodObjectLike {
  return z.object({ safeParse: z.function() }).safeParse(value).success;
}

function shapeKeys(schema: ZodObjectLike, seen: Set<ZodObjectLike> = new Set()): string[] | undefined {
  if (seen.has(schema)) return undefined;
  seen.add(schema);
  if (schema.shape && typeof schema.shape === "object") {
    return Object.keys(schema.shape).sort((a, b) => a.localeCompare(b));
  }
  for (const candidate of [
    schema._def?.schema,
    schema._def?.innerType,
    schema._def?.type,
    schema._def?.out,
  ]) {
    if (typeof candidate === "object" && candidate !== null && isZodSchema(candidate)) {
      const keys = shapeKeys(candidate, seen);
      if (keys) return keys;
    }
  }
  return undefined;
}

function discriminatorValue(option: ZodObjectLike, discriminator: string): string | undefined {
  const field = option.shape?.[discriminator];
  if (field === undefined || !isZodSchema(field)) return undefined;
  // Zod 4 literals expose the public `.value` getter and store `_def.values`;
  // Zod 3 stored `_def.value`. Accept either so the snapshot stays stable.
  const value = field.value ?? field._def?.value;
  return typeof value === "string" ? value : undefined;
}

export async function buildSchemaSnapshot(): Promise<SchemaSnapshot> {
  const snapshot: Record<string, readonly string[]> = {};
  const protocol: Record<string, object> = protocolExports;

  for (const [namespaceName, namespaceValue] of Object.entries(protocol)) {
    if (typeof namespaceValue !== "object" || namespaceValue === null) {
      continue;
    }
    // The imported protocol barrel is trusted code; its namespace properties
    // include schemas, functions, and scalar constants rather than JSON input.
    const namespace = namespaceValue as Record<string, object | string | number | boolean | null | undefined>;
    for (const [exportName, exportValue] of Object.entries(namespace)) {
      if (typeof exportValue !== "object" || exportValue === null || !isZodSchema(exportValue)) {
        continue;
      }
      const keys = shapeKeys(exportValue);
      if (keys) {
        snapshot[`${namespaceName}.${exportName}`] = keys;
        continue;
      }
      if (Array.isArray(exportValue.options)) {
        // Key discriminated-union options by their discriminator value, not
        // array position: reordering or inserting an option must not renumber
        // the others (an index shift reads as every later option "losing"
        // fields). Plain unions without a discriminator keep index keys.
        const discriminator = exportValue._def?.discriminator;
        exportValue.options.forEach((option: object, index: number) => {
          if (isZodSchema(option)) {
            const optionKeys = shapeKeys(option);
            if (optionKeys) {
              const label =
                typeof discriminator === "string"
                  ? discriminatorValue(option, discriminator)
                  : undefined;
              snapshot[`${namespaceName}.${exportName}#${label ?? index}`] = optionKeys;
            }
          }
        });
      }
    }
  }

  return Object.fromEntries(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b)));
}

export function diffSnapshots(previous: SchemaSnapshot, current: SchemaSnapshot): Violation[] {
  const violations: Violation[] = [];
  for (const [typeName, previousFields] of Object.entries(previous)) {
    const currentFields = current[typeName];
    if (!currentFields) {
      violations.push({
        check: "schema-snapshot",
        subject: typeName,
        message:
          "protocol type disappeared from the snapshot — removing/renaming an event type silently corrupts the ledger fold; introduce a new type and upcast on read (run --update only with Owner sign-off)",
      });
      continue;
    }
    const currentSet = new Set(currentFields);
    const removed = previousFields.filter((field) => !currentSet.has(field));
    if (removed.length > 0) {
      violations.push({
        check: "schema-snapshot",
        subject: typeName,
        message: `field(s) removed or renamed: ${removed.join(", ")} — a changed meaning is a new event type; shape evolution is upcast-on-read (run --update only with Owner sign-off)`,
      });
    }
  }
  return violations;
}

async function checkSchemaSnapshot(): Promise<Violation[]> {
  const previous = z.record(z.string(), z.array(z.string())).parse(decodeJson(readFileSync(SNAPSHOT_PATH, "utf8")));
  const current = await buildSchemaSnapshot();
  return diffSnapshots(previous, current);
}

export function buildToolSchemaSnapshot(): readonly Tool.Spec[] {
  return allToolSpecs(definitions);
}

export function diffToolSchemaSnapshots<T extends { readonly name?: string }>(
  previous: readonly T[],
  current: readonly T[],
): Violation[] {
  if (JSON.stringify(previous) === JSON.stringify(current)) return [];
  const previousNames = previous.flatMap((value) => typeof value.name === "string" ? [value.name] : []);
  const currentNames = current.flatMap((value) => typeof value.name === "string" ? [value.name] : []);
  return [
    {
      check: "tool-schema-snapshot",
      subject: "catalogDefinitions",
      message: `derived tool specs differ from the reviewed snapshot (before: ${previousNames.join(", ")}; now: ${currentNames.join(", ")}) — run --update only with review authorization`,
    },
  ];
}

function checkToolSchemaSnapshot(): Violation[] {
  const previous = z.array(z.object({ name: z.string() }).catchall(z.json())).parse(
    decodeJson(readFileSync(TOOL_SNAPSHOT_PATH, "utf8")),
  );
  return diffToolSchemaSnapshots(previous, buildToolSchemaSnapshot());
}

// ---------------------------------------------------------------------------
// self-test — every check must flag a known-bad fixture (discrimination bench)
// ---------------------------------------------------------------------------

export interface SelfTestChecks {
  readonly exemplar: AnyToolDefinition | undefined;
  readonly unmappedNamespaces: typeof unmappedNamespaces;
  readonly lintToolSurface: typeof lintToolSurface;
  readonly namingOffenders: typeof namingOffenders;
  readonly definitionInvariantViolations: typeof definitionInvariantViolations;
  readonly topLevelFieldCount: typeof topLevelFieldCount;
  readonly diffSnapshots: typeof diffSnapshots;
  readonly diffToolSchemaSnapshots: typeof diffToolSchemaSnapshots;
}

export const defaultChecks: SelfTestChecks = {
  exemplar: definitions[0], unmappedNamespaces, lintToolSurface, namingOffenders,
  definitionInvariantViolations, topLevelFieldCount, diffSnapshots, diffToolSchemaSnapshots,
};

type SelfTestRow = readonly [ok: boolean, message: string];

function definitionSelfTest(checks: SelfTestChecks): SelfTestRow[] {
  const exemplar = checks.exemplar;
  if (!exemplar) return [[false, "definition invariant self-test has no exemplar"]];
  const unsafeQuery = { ...exemplar, name: "unsafe_query", category: "query" } as AnyToolDefinition;
  const fileNameChecks = [
    ["send_message", "apps/openomni/src/bundles/tools/send-message.ts", 0],
    ["send_message", "apps/openomni/src/bundles/tools/send_message.ts", 1],
    ["read", "apps/openomni/src/bundles/tools/files/read.ts", 0],
    ["read", "apps/openomni/src/bundles/tools/files/read-file.ts", 1],
  ] as const;
  const invalidDefinition = { ...exemplar, name: "", description: "" } as AnyToolDefinition;
  const invalidMessages = checks.definitionInvariantViolations(
    [invalidDefinition], [{ definition: invalidDefinition, filePath: "apps/openomni/src/bundles/tools/.ts" }],
  ).map(({ message }) => message);
  const unknownCategory: AnyToolDefinition = { ...exemplar };
  Object.defineProperty(unknownCategory, "category", { value: "unregistered" });
  return [
    [checks.definitionInvariantViolations([], [{ definition: unsafeQuery, filePath: "apps/openomni/src/bundles/tools/query/unsafe.ts" }])
      .some(({ check }) => check === "earned-check"), "earned-check did not flag an uncatalogued definition"],
    ...fileNameChecks.map(([name, filePath, expected]): SelfTestRow => {
      const definition = { ...exemplar, name } as AnyToolDefinition;
      const flagged = checks.definitionInvariantViolations([definition], [{ definition, filePath }])
        .filter(({ message }) => message.startsWith("[tool-file-name]")).length;
      return [flagged === expected, `tool-file-name misjudged ${filePath} for ${name}`];
    }),
    [invalidMessages.some((message) => message.startsWith("[tool-name]")) &&
      invalidMessages.some((message) => message.startsWith("[tool-description]")),
    "definition invariants missed empty name or description"],
    [checks.definitionInvariantViolations([unknownCategory], [{ definition: unknownCategory,
      filePath: `apps/openomni/src/bundles/tools/${unknownCategory.name.replaceAll("_", "-")}.ts` }])
      .some(({ message }) => message.startsWith("[tool-category]")),
    "definition invariants missed an unregistered tool category"],
  ];
}

export function selfTestFailures(checks: SelfTestChecks = defaultChecks): string[] {
  const nouns = extractTierNouns("**Tier 1 (philosophy):** Actor, Ledger.\n**Tier 2 (specification):** Wait.");
  const rows: SelfTestRow[] = [
    [agentSourceFacts("packages/agent/src/core/ports/types.ts", "const ModelPort = 1;").retiredTokens === 1,
      "core end-state scan missed retired vocabulary"],
    [agentSourceFacts("packages/agent/src/core/ports/types.ts", 'const code = "seam_missing";').retiredTokens === 0,
      "core end-state scan rejected a durable quoted identifier"],
    [checks.unmappedNamespaces(["actor", "totally-new-thing"], nouns).join() === "totally-new-thing",
      "vocab-ratchet did not flag an unmapped namespace"],
    [checks.unmappedNamespaces(["wait"], nouns).length === 0,
      "vocab-ratchet flagged a mapped namespace (wait→Wait)"],
    [checks.lintToolSurface({ name: "DoThingNowFastPlease", description: "", inputSchema: {
      type: "object", properties: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {}, g: {}, h: {} },
    } }).length === 3, "tool-lint did not flag name/description/field-count on a known-bad tool"],
    [checks.lintToolSurface({ name: "read", description: "ok", inputSchema: {
      type: "object", properties: { path: {} },
    } }).length === 0, "tool-lint flagged a known-good tool"],
    [checks.namingOffenders("x.ts", "export const FooTaskEnvelope = 1;").length > 0,
      "naming lint did not flag a banned noun"],
    [checks.namingOffenders("x.ts", "export const WaitSchema = 1;").length === 0,
      "naming lint flagged a clean identifier"],
    ...definitionSelfTest(checks),
  ];
  const composedSchema: PlainObject = {
    $defs: { common: { type: "object", properties: { a: {}, b: {}, c: {} } } },
    allOf: [{ $ref: "#/$defs/common" }, { anyOf: [
      { type: "object", properties: { d: {}, e: {} } },
      { type: "object", properties: { d: {}, e: {}, f: {} } },
    ] }],
  };
  const recursiveSchema: PlainObject = {
    $defs: { "common/fields": { properties: { h: {} }, $ref: "#/$defs/common~1fields" } },
    properties: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {}, g: {} },
    $ref: "#/$defs/common~1fields",
  };
  const snapshotViolations = checks.diffSnapshots(
    { "Tool.Call": ["id", "input", "tool"] }, { "Tool.Call": ["id", "payload", "tool"] },
  );
  rows.push(
    [checks.topLevelFieldCount(composedSchema) === 6,
      "tool field budget walker did not follow allOf/anyOf/$ref"],
    [checks.lintToolSurface({ name: "read", description: "ok", inputSchema: recursiveSchema })
      .map((failure) => failure.rule).join() === "tool-max-fields",
    "tool field budget walker lost escaped recursive reference fields"],
    [snapshotViolations.length === 1 && !!snapshotViolations[0]?.message.includes("input"),
      "schema-snapshot did not flag a field rename"],
    [checks.diffSnapshots({ "Tool.Call": ["id"] }, {}).map((violation) => violation.subject).join() === "Tool.Call",
      "schema-snapshot did not flag a removed type"],
    [checks.diffSnapshots({ "Tool.Call": ["id"] }, { "Tool.Call": ["id", "extra"] }).length === 0,
      "schema-snapshot flagged an additive change"],
    [checks.diffToolSchemaSnapshots([{ name: "a" }], [{ name: "b" }]).length === 1,
      "tool-schema snapshot did not flag a derived spec change"],
    [checks.diffToolSchemaSnapshots([{ name: "a" }], [{ name: "a" }]).length === 0,
      "tool-schema snapshot flagged identical derived specs"],
  );
  return rows.filter(([ok]) => !ok).map(([, message]) => message);
}

export function selfTest(): void {
  const failures = selfTestFailures();
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`SELF-TEST FAIL: ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write("OK: lint-tools self-test — all checks discriminate on known-bad fixtures\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function reportViolations(violations: readonly Violation[]): never {
  for (const violation of violations) {
    process.stderr.write(`VIOLATION [${violation.check}] ${violation.subject} — ${violation.message}\n`);
  }
  process.exit(1);
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  hooks: {
    readonly writeSnapshot?: (path: string, contents: string) => void;
    readonly coreEndState?: () => Promise<string[]>;
  } = {},
): Promise<void> {
  const args = new Set(argv);

  if (args.has("--self-test")) {
    selfTest();
    return;
  }

  if (args.has("--update")) {
    const snapshot = await buildSchemaSnapshot();
    const toolSnapshot = buildToolSchemaSnapshot();
    (hooks.writeSnapshot ?? writeFileSync)(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    (hooks.writeSnapshot ?? writeFileSync)(TOOL_SNAPSHOT_PATH, `${JSON.stringify(toolSnapshot, null, 2)}\n`);
    process.stdout.write(
      `OK: snapshots regenerated (${Object.keys(snapshot).length} protocol types, ${toolSnapshot.length} derived tool specs) — these diffs are the review surface\n`,
    );
    return;
  }

  const baseline = z.object({
    vocab: z.object({ unmappedNamespaces: z.array(z.string()) }),
    tools: z.object({ exceptions: z.record(z.string(), z.array(z.string())) }).optional(),
    naming: z.object({ grandfathered: z.array(z.string()) }),
  }).parse(decodeJson(readFileSync(BASELINE_PATH, "utf8")));
  const violations = [
    ...(await checkVocabRatchet(baseline)),
    ...(await checkToolLint(baseline)),
    ...(await checkNaming(baseline)),
    ...(await checkEarned()),
    ...(await checkSchemaSnapshot()),
    ...checkToolSchemaSnapshot(),
    ...(await (hooks.coreEndState ?? checkCoreEndState)()).map((message): Violation => ({
      check: "core-end-state", subject: "packages/agent", message,
    })),
  ];

  if (violations.length > 0) reportViolations(violations);
  process.stdout.write(
    "OK: conformance lint — vocab ratchet, definition invariants, tool lint, naming, earned, protocol schema snapshot, derived tool snapshot\n",
  );
}

if (import.meta.main) await runScriptMain(() => main());
