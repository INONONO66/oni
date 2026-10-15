import { CELL_CEILING_MS, describe } from "../core/cell-output";
import { CodemodeError, type RunOptions } from "@openomni/codemode";
import { Bundle, Core } from "@openomni/agent";
import { boundTool, ToolCapabilityPort } from "../../seams";
import { ABSENT_MACHINE_PORTS, type MachineToolPortsSource } from "../core/ports";
const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;
import { Machine } from "@openomni/protocol";
import { z } from "zod";

export interface Cell {
  run(code: string, tenant: string, options: RunOptions): Promise<Machine.CellState>;
  peek(cellId: string, tenant: string): Promise<Machine.CellState>;
  stop(cellId: string, tenant: string): Promise<Machine.CellState>;
}

const cellId = z.string().min(1).describe("The cell_id a run answered with while still running.");
const operation = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("run"),
      code: z.string().min(1),
      timeout: z
        .number()
        .int()
        .positive()
        .default(15)
        .describe(
          "Seconds to wait for the cell. A cell still running is answered as running with its cell_id and keeps going in the background.",
        ),
    })
    .strict(),
  z.object({ op: z.literal("peek"), cell_id: cellId }).strict(),
  z.object({ op: z.literal("stop"), cell_id: cellId }).strict(),
]);
type Operation = z.output<typeof operation>;
// Like monitor and provision: an object root keeps the op union out of the wire root.
const Input = z.object({ operation }).strict();

function executeOperation(
  cell: Cell,
  operation: Operation,
  sessionId: string,
  signal: AbortSignal,
): Promise<Machine.CellState> {
  return cellOperation(cell, operation, sessionId, signal).catch((error: Error) => {
    if (error instanceof CodemodeError && error.reason === "unknown_cell_id")
      throw new ToolRefused("eval", "no such cell_id in this session");
    throw error;
  });
}

/** Sync throws from the cell surface become rejections here, so one catch above sees every failure. */
async function cellOperation(
  cell: Cell,
  operation: Operation,
  sessionId: string,
  signal: AbortSignal,
): Promise<Machine.CellState> {
  if (operation.op === "run")
    return await cell.run(operation.code, sessionId, {
      timeoutMs: CELL_CEILING_MS,
      waitMs: operation.timeout * 1000,
      signal,
    });
  if (operation.op === "peek") return await cell.peek(operation.cell_id, sessionId);
  return await cell.stop(operation.cell_id, sessionId);
}

/** The catalog is static: without a composed codemode the tool exists and refuses. */
export function createEvalTool(cell: Cell | undefined) {
  return defineTool({
    name: "eval",
    category: "execution",
    description:
      "Run Python in this session's persistent cell: state survives between calls; machine handles, parallel, completion, browser(machineId) for Chromium automation over CDP, and tool.<name>() proxies are in scope. operation.op=run starts code and waits up to timeout seconds; peek reads a running cell's output so far; stop interrupts it. stop and the 10 minute ceiling discard the interpreter's state.",
    input: Input,
    output: Machine.CellState,
    visibility: { model: ["resident", "child"], cell: ["resident", "child"] },
    execute: ({ operation }, ctx) => {
      if (cell === undefined) throw new ToolRefused("eval", "codemode is not composed");
      return executeOperation(cell, operation, ctx.sessionId, ctx.signal);
    },
    render: (_args, value) => describe(value),
  });
}

/** The `eval` bundle (#1561): the session's persistent code cell. */
export function evalBundle(ports: MachineToolPortsSource): Bundle.BundleContract<"eval"> {
  return Bundle.define({
    name: "eval",
    requires: [ToolCapabilityPort],
    tools: [boundTool(ports, ABSENT_MACHINE_PORTS, (live) => createEvalTool(live.cells?.cell))],
  });
}
