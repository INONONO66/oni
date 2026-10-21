import { Core } from "@oni/agent";
const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;
import { z } from "zod";
import { fileOperation, filesystem, type FilePorts } from "../core/filesystem";

export function createWriteTool(ports: FilePorts) {
  return defineTool({
    name: "write",
    description:
      "Create or overwrite one /absolute (default machine) or machineId:/absolute/path file. Parent directories must exist.",
    category: "mutation",
    sequential: true,
    input: z
      .object({
        path: z.string().min(1),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
      })
      .strict(),
    output: z.object({ bytesWritten: z.number().int().nonnegative() }),
    visibility: { model: ["resident", "child"], cell: ["resident", "child"] },
    execute: (args, ctx) =>
      fileOperation("write", async () => {
        ctx.signal.throwIfAborted();
        const data = Buffer.from(args.content, args.encoding);
        if (args.encoding === "base64" && data.toString("base64") !== args.content)
          throw new ToolRefused("write", "expected canonical base64");
        return { bytesWritten: await filesystem(args.path, ports).write(data) };
      }),
    render: (_args, value) => JSON.stringify(value),
  });
}
