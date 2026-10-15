import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { Bundle, Core } from "@openomni/agent";
import type { ToolExecutionContext } from "@openomni/protocol";
import { z } from "zod";
import { boundTool, ToolCapabilityPort } from "../../seams";
import { ABSENT_MACHINE_PORTS, type MachineToolPortsSource } from "../core/ports";
import { fileOperation } from "../core/filesystem";

const Tool = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  description: z.string().trim().min(1),
  inputSchema: z.record(z.string(), z.json()),
  machine: z.string().min(1),
  command: z.string().trim().min(1),
});
const Manifest = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  tools: z.array(Tool).min(1),
});
type Pack = z.infer<typeof Manifest>;
const PLACEHOLDER = /{{([a-z][a-z0-9_]*)}}/g;
const Output = z.strictObject({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  truncated: z.boolean(),
});

type Refuse = (message: string, code: string) => never;

function invalid(path: string, detail: string, refuse: Refuse): never {
  return refuse(`tool pack ${path}: ${detail}`, "invalid_tool_pack");
}

function readPack(path: string, refuse: Refuse): Pack {
  let value: string;
  try {
    value = readFileSync(join(path, "manifest.json"), "utf8");
  } catch (cause) {
    return invalid(path, `cannot read manifest.json: ${String(cause)}`, refuse);
  }
  let parsed: z.infer<typeof z.json>;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    return invalid(path, `manifest.json is not JSON: ${String(cause)}`, refuse);
  }
  const result = Manifest.safeParse(parsed);
  if (!result.success) return invalid(path, result.error.message, refuse);
  return result.data;
}

function standaloneArgument(command: string, match: RegExpMatchArray): boolean {
  const start = match.index;
  if (start === undefined) return false;
  const end = start + match[0].length;
  let quote = "";
  for (let i = 0; i < start; i++) {
    const character = command[i];
    if (character === "\\" && quote !== "'") { i++; continue; }
    if (character === quote) quote = "";
    else if (quote === "" && (character === "'" || character === '"' || character === "`"))
      quote = character;
  }
  return quote === "" &&
    (start === 0 || /\s/.test(command[start - 1] ?? "")) &&
    (end === command.length || /\s/.test(command[end] ?? ""));
}

function packInput(path: string, tool: Pack["tools"][number], refuse: Refuse): z.ZodType {
  if (tool.inputSchema.type !== "object") return invalid(path, `${tool.name} inputSchema must be an object`, refuse);
  const properties = z.record(z.string(), z.json()).safeParse(tool.inputSchema.properties ?? {});
  const required = z.array(z.string()).safeParse(tool.inputSchema.required ?? []);
  if (!properties.success || !required.success)
    return invalid(path, `${tool.name} inputSchema properties/required are invalid`, refuse);
  const fields = new Set(Object.keys(properties.data));
  const mandatory = new Set(required.data);
  const placeholders = [...tool.command.matchAll(PLACEHOLDER)];
  if (tool.command.replace(PLACEHOLDER, "").includes("{{") || tool.command.replace(PLACEHOLDER, "").includes("}}"))
    return invalid(path, `${tool.name} has an invalid placeholder`, refuse);
  for (const match of placeholders) {
    if (!standaloneArgument(tool.command, match))
      return invalid(path, `${tool.name} placeholder must be a standalone shell argument`, refuse);
    const field = match[1];
    if (field === undefined || !fields.has(field) || !mandatory.has(field))
      return invalid(path, `${tool.name} placeholder ${field} must name a required input property`, refuse);
  }
  try {
    const input = z.fromJSONSchema(tool.inputSchema);
    z.toJSONSchema(input);
    return input;
  } catch (cause) {
    return invalid(path, `${tool.name} inputSchema is unsupported: ${String(cause)}`, refuse);
  }
}

/** A pack is data only: convert its JSON Schema to a tool face before composition. */
export function loadToolPacks(
  dir: string | undefined,
  machineIds: ReadonlySet<string>,
  ports: MachineToolPortsSource,
  refuse: Refuse,
): readonly Bundle.BundleContract[] {
  if (dir === undefined) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (cause) {
    return invalid(dir, `cannot list directory: ${String(cause)}`, refuse);
  }
  const names = new Set<string>();
  const bundles = new Set<string>();
  return entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const path = join(dir, entry.name);
    if (!entry.isDirectory()) return invalid(path, "expected a pack directory", refuse);
    const pack = readPack(path, refuse);
    if (bundles.has(pack.name)) return invalid(path, `duplicate bundle ${pack.name}`, refuse);
    bundles.add(pack.name);
    return Bundle.define({
      name: pack.name,
      requires: [ToolCapabilityPort],
      tools: pack.tools.map((tool) => {
        if (names.has(tool.name))
          return refuse(`tool pack ${path}: duplicate tool ${tool.name}`, "tool_name_collision");
        names.add(tool.name);
        if (!machineIds.has(tool.machine))
          return refuse(`tool pack ${path}: machine ${tool.machine} is not enrolled`, "unknown_machine");
        const input = packInput(path, tool, refuse);
        return boundTool(ports, ABSENT_MACHINE_PORTS, (live) =>
          Core.defineTool({
            name: tool.name,
            description: tool.description,
            category: "execution",
            sequential: true,
            input,
            output: Output,
            visibility: { model: ["resident", "child"], cell: ["resident", "child"] },
            execute: (args: z.output<typeof input>, ctx: ToolExecutionContext) => fileOperation(tool.name, async () => {
              ctx.signal.throwIfAborted();
              const values = z.record(z.string(), z.json()).parse(args);
              const command = tool.command.replace(PLACEHOLDER, (_match, key: string) => {
                const value = values[key];
                const text = typeof value === "string" ? value : JSON.stringify(value);
                return `'${text.replaceAll("'", "'\\''")}'`;
              });
              const machine = live.machines?.get(tool.machine);
              if (machine === undefined) throw new Core.ToolRefused(tool.name, "machine host is not configured");
              const result = await machine.exec(command, "/");
              if (result.status !== "completed")
                throw new Core.ToolRefused(tool.name, result.status === "refused" ? result.reason : result.status);
              return {
                stdout: Buffer.from(result.stdout).toString("utf8"),
                stderr: Buffer.from(result.stderr).toString("utf8"),
                exitCode: result.exitCode,
                signal: result.signal,
                truncated: result.truncated,
              };
            }),
            render: (_args: z.output<typeof input>, value: z.output<typeof Output>) => JSON.stringify(value),
          }),
        );
      }),
    });
  });
}
