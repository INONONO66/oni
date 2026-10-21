import type { ComposedCodemode } from "../../src/composition/codemode";
import type { ToolPorts } from "../../src/composition/catalog";
import { runEffect } from "./effect";

/** The test boundary mirrors the app's Promise-facing tool ports. */
export function cellPorts(cells: ComposedCodemode): NonNullable<ToolPorts["cells"]> {
  return {
    cell: {
      run: (code, tenant, options) => runEffect(cells.cell.run(code, tenant, options)),
      peek: (id, tenant) => runEffect(cells.cell.peek(id, tenant)),
      stop: (id, tenant) => runEffect(cells.cell.stop(id, tenant)),
    },
  };
}
