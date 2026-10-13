import type { Machine } from "@openomni/protocol";

/** A background cell cannot outlive this session-owned ceiling. */
export const CELL_CEILING_MS = 10 * 60_000;

function outputOf(output: Machine.CellOutput): string {
  const streams = [output.stdout, output.stderr].filter((stream) => stream !== "");
  return streams.length === 0 ? "" : `\n${streams.join("\n")}`;
}

export function describe(state: Machine.CellState): string {
  if (state.status === "completed") return state.value ?? state.output.stdout;
  if (state.status === "raised") return `the cell raised: ${state.error}${outputOf(state.output)}`;
  if (state.status === "running")
    return `cell ${state.cellId} is still running; peek or stop it by cell_id${outputOf(state.output)}`;
  if (state.status === "timed_out")
    return `the cell was stopped at the ${CELL_CEILING_MS / 60_000} minute ceiling${outputOf(state.output)}`;
  if (state.status === "cancelled") return `the cell was stopped${outputOf(state.output)}`;
  return state.reason;
}
