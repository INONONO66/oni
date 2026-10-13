import { Core } from "@openomni/agent";
const ToolRefused = Core.ToolRefused;
import { Machine } from "@openomni/protocol";

/** Every locus is a machine locus (#1271); there is no local variant. */
export type Locus = { readonly kind: "machine"; readonly machine: string; readonly path: string };

export interface LocusOptions {
  /**
   * The machine a prefix-less path resolves to — the configured
   * `machines.default`, passed by the caller, never process-local state.
   */
  readonly defaultMachine: string;
}

/**
 * A colon before the first slash introduces a machine id, including
 * single-letter ids. A prefix-less path targets the default machine; every
 * path is absolute because no process working directory exists to resolve
 * against (#1271).
 */
export function parseLocus(input: string, options: LocusOptions): Locus {
  if (input.length === 0 || input.includes("\0"))
    throw new ToolRefused("locus", "path must be nonempty and contain no NUL");
  if (input === "/machines" || input.startsWith("/machines/"))
    throw new ToolRefused("locus", "virtual machine roots are not supported");
  const colon = input.indexOf(":");
  const slash = input.indexOf("/");
  const prefixless = colon < 0 || (slash >= 0 && slash < colon);
  const machine = prefixless ? options.defaultMachine : input.slice(0, colon);
  const path = prefixless ? input : input.slice(colon + 1);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(machine) ||
    path.startsWith("//") ||
    !Machine.AbsolutePath.safeParse(path).success
  ) {
    throw new ToolRefused("locus", "expected /absolute/path or machineId:/absolute/path");
  }
  return { kind: "machine", machine, path };
}
