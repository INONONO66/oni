import { Core } from "@oni/agent";
const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;
import { z } from "zod";
import { fileOperation, walker, type FilePorts } from "../core/filesystem";

export function createFindTool(ports: FilePorts) {
  const walk = walker(ports);
  return defineTool({
    name: "find",
    description:
      "Find files and directories whose path relative to the search root matches a glob (e.g. **/*.ts). path is /absolute (searched on the default machine) or machineId:/absolute/path. Symlinks are not followed.",
    category: "query",
    input: z
      .object({
        pattern: z.string().min(1),
        path: z.string().min(1),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    output: z.object({ paths: z.array(z.string()), truncated: z.boolean() }),
    visibility: { model: ["resident", "child"], cell: ["resident", "child"] },
    execute: (args, ctx) =>
      fileOperation("find", async () => {
        const glob = new Bun.Glob(args.pattern);
        const paths: string[] = [];
        let truncated = false;
        await walk(args.path, ctx.signal, async (path) => {
          const relative = relativeTo(args.path, path);
          if (relative === "" || !glob.match(relative)) return true;
          truncated = !admit(paths, path, args.limit);
          return !truncated;
        });
        return { paths, truncated };
      }),
    render: (_args, value) => renderPaths(value),
  });
}

/** One path per line, truncation stated last. */
function renderPaths(value: { readonly paths: readonly string[]; readonly truncated: boolean }) {
  return [...value.paths, ...(value.truncated ? ["[truncated: limit reached]"] : [])].join("\n");
}

/** Record a hit unless the limit is already spent; false tells the walk to stop. */
function admit(paths: string[], path: string, limit: number | undefined): boolean {
  if (paths.length >= (limit ?? Number.POSITIVE_INFINITY)) return false;
  paths.push(path);
  return true;
}

/** The walked path minus the search root; a walk outside the root is an impossible state, refused. */
function relativeTo(root: string, path: string): string {
  if (path === root) return "";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!path.startsWith(prefix)) throw new ToolRefused("find", `walked path ${path} escaped search root ${root}`);
  return path.slice(prefix.length);
}
