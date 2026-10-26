/**
 * Exports the machine wire contract (`Machine.*` Zod schemas, the `Events`
 * payloads and the `WireMethod` table) as draft-7 JSON Schema under
 * `packages/protocol/schema/machine/`, one file per schema plus `index.json`.
 *
 *   bun run script/generate-machine-schema.ts           rewrite the export
 *   bun run script/generate-machine-schema.ts --check   exit 1 listing stale files
 *
 * Unrepresentable fallback (`unrepresentable: "any"` emits `{}` for the part):
 *   ToolCall          custom: `arguments` values are PlainValueSchema
 *   ToolCallResult    custom: `completed.value` is PlainValueSchema
 *   ScreenReadResult  custom: `ok.accessibilityTree` is PlainValueSchema
 *   ScreenCaptureResult custom: `ok.accessibilityTree` is PlainValueSchema
 *
 * Refinements dropped by the export (the base type is kept; Zod still
 * enforces them at parse time):
 *   AbsolutePath, ExecRequest, Offer, PtyOpenRequest   refine: absolute path without NUL or ..
 *   FsRequest, FsStreamRequest                         refine: export-relative path
 *   Enrollment, Info, Offer, AttachResult, EventEnrolled, EventAttached
 *                                                      refine: unique capability/export names
 *   CapacityRows                                       refine: unique selectors
 *   CellOutput, CellResult, CellState, PeekResult, PeekAnswer
 *                                                      refine: per-stream byte bound
 *   ScreenReadResult, ScreenCaptureResult              refine: accessibility tree byte bound
 * Regex grammars (CapabilityId, ExportName, KeyFingerprint, PtySessionName,
 * base64 fields) are carried as `pattern`.
 */
import { readdirSync, rmSync } from "node:fs";
import { z } from "zod";
import { Machine, type PlainValue } from "../packages/protocol/src/index.js";

const SCHEMA_DIR = new URL("../packages/protocol/schema/machine/", import.meta.url);
const INDEX_FILE = "index.json";

export interface MachineSchemaEntry {
  readonly name: string;
  readonly schema: z.ZodType;
}

/** Every machine wire schema, sorted by name; event payloads are `Event<Key>`. */
export function machineSchemas(): MachineSchemaEntry[] {
  const entries: MachineSchemaEntry[] = [
    { name: "WireMethod", schema: z.enum(Machine.WireMethod) },
  ];
  for (const [name, value] of Object.entries(Machine)) {
    if (value instanceof z.ZodType) entries.push({ name, schema: value });
  }
  for (const [key, event] of Object.entries(Machine.Events)) {
    entries.push({ name: `Event${key}`, schema: event.schema });
  }
  return entries.sort((left, right) => compareText(left.name, right.name));
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortKeys(_key: string, value: PlainValue): PlainValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => compareText(left, right)),
  );
}

function render(value: object): string {
  return `${JSON.stringify(value, sortKeys, 2)}\n`;
}

export function renderMachineSchemas(): Map<string, string> {
  const files = new Map<string, string>();
  const schemas = machineSchemas();
  for (const { name, schema } of schemas) {
    files.set(
      `${name}.json`,
      render(z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" })),
    );
  }
  files.set(
    INDEX_FILE,
    render({
      contractVersion: Machine.contractVersion,
      schemas: schemas.map(({ name }) => ({ name, file: `${name}.json` })),
    }),
  );
  return files;
}

function existingFiles(dir: URL): string[] {
  try {
    return readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function staleFiles(dir: URL, expected: Map<string, string>): Promise<string[]> {
  const stale = existingFiles(dir).filter((file) => !expected.has(file));
  for (const [file, content] of expected) {
    const target = Bun.file(new URL(file, dir));
    if (!(await target.exists()) || (await target.text()) !== content) stale.push(file);
  }
  return stale.sort(compareText);
}

export async function main(
  argv: readonly string[] = process.argv,
  dir: URL = SCHEMA_DIR,
): Promise<void> {
  const expected = renderMachineSchemas();
  if (argv.includes("--check")) {
    const stale = await staleFiles(dir, expected);
    if (stale.length > 0) {
      console.error(
        `Machine JSON Schema export is stale (${stale.join(", ")}). Run: bun run script/generate-machine-schema.ts`,
      );
      process.exitCode = 1;
    } else {
      console.log("Machine JSON Schema export is current");
    }
    return;
  }
  for (const file of existingFiles(dir)) {
    if (!expected.has(file)) rmSync(new URL(file, dir));
  }
  for (const [file, content] of expected) await Bun.write(new URL(file, dir), content);
  console.log(`Wrote ${expected.size} machine JSON Schema files`);
}

if (import.meta.main) await main();
