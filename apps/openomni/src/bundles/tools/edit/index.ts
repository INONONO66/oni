import { Core } from "@openomni/agent";
const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;
import { z } from "zod";
import { fileOperation, filesystem, text, type FilePorts } from "../core/filesystem";

const Edit = z.object({ oldText: z.string().min(1), newText: z.string() }).strict();

/** Every oldText must match the original exactly once and no two matches may overlap. */
function apply(content: string, edits: readonly z.output<typeof Edit>[]): string {
  const spans = edits.map((edit) => {
    const index = content.indexOf(edit.oldText);
    if (index < 0 || content.indexOf(edit.oldText, index + 1) >= 0)
      throw new ToolRefused("edit", "each oldText must match exactly once");
    return { start: index, end: index + edit.oldText.length, newText: edit.newText };
  });
  spans.sort((a, b) => a.start - b.start);
  let cursor = 0;
  let result = "";
  for (const span of spans) {
    if (span.start < cursor) throw new ToolRefused("edit", "edits must not overlap");
    result += content.slice(cursor, span.start) + span.newText;
    cursor = span.end;
  }
  return result + content.slice(cursor);
}

export function createEditTool(ports: FilePorts) {
  return defineTool({
    name: "edit",
    description:
      "Apply one or more exact literal UTF-8 replacements to one /absolute (default machine) or machineId:/absolute/path file. Each oldText must match exactly once in the original and edits must not overlap. Read/write composition is not atomic against external writers.",
    category: "mutation",
    sequential: true,
    input: z.object({ path: z.string().min(1), edits: z.array(Edit).min(1) }).strict(),
    output: z.object({ bytesWritten: z.number().int().nonnegative() }),
    visibility: { model: ["resident", "child"], cell: ["resident", "child"] },
    execute: (args, ctx) =>
      fileOperation("edit", async () => {
        ctx.signal.throwIfAborted();
        const endpoint = filesystem(args.path, ports);
        const next = apply(text(await endpoint.read()), args.edits);
        ctx.signal.throwIfAborted();
        return { bytesWritten: await endpoint.write(Buffer.from(next)) };
      }),
    render: (_args, value) => JSON.stringify(value),
  });
}
