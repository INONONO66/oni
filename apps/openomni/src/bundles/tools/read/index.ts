import { Core } from "@openomni/agent";
const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;
import { z } from "zod";
import { fileOperation, filesystem, text, type FilePorts } from "../core/filesystem";

const Input = z
  .object({
    path: z.string().min(1),
    offset: z.number().int().positive().optional().describe("First line to return, 1-based."),
    limit: z.number().int().positive().optional().describe("Maximum number of lines."),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  })
  .strict();

function window(content: string, args: z.output<typeof Input>): string {
  if (args.offset === undefined && args.limit === undefined) return content;
  const lines = content.split("\n");
  const start = (args.offset ?? 1) - 1;
  return lines.slice(start, args.limit === undefined ? undefined : start + args.limit).join("\n");
}

export function createReadTool(ports: FilePorts) {
  return defineTool({
    name: "read",
    description:
      "Read an /absolute path (on the default machine) or machineId:/absolute/path. UTF-8 text by default with an optional line window (offset, limit); base64 preserves binary bytes.",
    category: "query",
    input: Input,
    output: z.object({ content: z.string(), bytes: z.number().int().nonnegative() }),
    visibility: { model: ["resident", "child"], cell: ["resident", "child"] },
    execute: (args, ctx) =>
      fileOperation("read", async () => {
        ctx.signal.throwIfAborted();
        if (args.encoding === "base64" && (args.offset !== undefined || args.limit !== undefined))
          throw new ToolRefused("read", "offset and limit apply to utf8 reads only");
        const bytes = await filesystem(args.path, ports).read();
        return {
          content: args.encoding === "base64" ? bytes.toString("base64") : window(text(bytes), args),
          bytes: bytes.length,
        };
      }),
    render: (_args, value) => value.content,
  });
}
