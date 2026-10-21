import { Core } from "@oni/agent";
const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;
import { z } from "zod";
import { fileOperation, filesystem, text, walker, type FilePorts } from "../core/filesystem";

const Input = z
  .object({
    pattern: z.string().min(1),
    path: z.string().min(1),
    glob: z.string().min(1).optional(),
    ignoreCase: z.boolean().default(false),
    literal: z.boolean().default(false),
    context: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().optional(),
  })
  .strict();
type Args = z.output<typeof Input>;

const Match = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  text: z.string(),
  before: z.array(z.string()),
  after: z.array(z.string()),
});
type Match = z.output<typeof Match>;

function compile(args: Args): RegExp {
  const source = args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : args.pattern;
  try {
    return new RegExp(source, args.ignoreCase ? "i" : "");
  } catch {
    throw new ToolRefused("grep", `invalid regular expression: ${args.pattern}`);
  }
}

function nameMatches(names: Bun.Glob | undefined, path: string): boolean {
  return names === undefined || names.match(path.slice(path.lastIndexOf("/") + 1));
}

/** Append one file's matches in line order; false once the limit is spent (the walk stops). */
function collect(matches: Match[], path: string, lines: string[], args: Args, pattern: RegExp) {
  const hits = [...lines.entries()].filter(([, line]) => pattern.test(line));
  for (const [index, line] of hits) {
    if (matches.length >= (args.limit ?? Number.POSITIVE_INFINITY)) return false;
    const before = lines.slice(Math.max(0, index - args.context), index);
    const after = lines.slice(index + 1, index + 1 + args.context);
    matches.push({ path, line: index + 1, text: line, before, after });
  }
  return true;
}

export function createGrepTool(ports: FilePorts) {
  const walk = walker(ports);
  return defineTool({
    name: "grep",
    description:
      "Search UTF-8 file content with a regular expression (literal=true for plain text) at an /absolute path (searched on the default machine) or machineId:/absolute/path. Directories recurse in name order without following symlinks; glob filters file names; context adds surrounding lines; binary files refuse.",
    category: "query",
    input: Input,
    output: z.object({ matches: z.array(Match), truncated: z.boolean() }),
    visibility: { model: ["resident", "child"], cell: ["resident", "child"] },
    execute: (args, ctx) =>
      fileOperation("grep", async () => {
        const pattern = compile(args);
        const names = args.glob === undefined ? undefined : new Bun.Glob(args.glob);
        const matches: Match[] = [];
        let truncated = false;
        await walk(args.path, ctx.signal, async (path, kind) => {
          if (kind !== "file" || !nameMatches(names, path)) return true;
          const lines = text(await filesystem(path, ports).read()).split("\n");
          truncated = !collect(matches, path, lines, args, pattern);
          return !truncated;
        });
        return { matches, truncated };
      }),
    render: (_args, value) => renderMatches(value),
  });
}

/** `path:line:text` per match, context lines marked with `-`, truncation stated last. */
function renderMatches(value: { matches: Match[]; truncated: boolean }): string {
  const lines: string[] = [];
  for (const match of value.matches) {
    let line = match.line - match.before.length;
    for (const before of match.before) lines.push(`${match.path}-${line++}-${before}`);
    lines.push(`${match.path}:${match.line}:${match.text}`);
    line = match.line + 1;
    for (const after of match.after) lines.push(`${match.path}-${line++}-${after}`);
  }
  if (value.truncated) lines.push("[truncated: limit reached]");
  return lines.join("\n");
}
