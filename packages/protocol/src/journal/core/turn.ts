/**
 * `turn` — one loop turn: open/checkpoint/tool.start/tool.result/terminal
 * phases, consumed input seqs (`deliveryIds`) plus `consumedStale` for
 * inputs closed without execution. Single writer: the session loop
 * (`packages/agent/src/core/commit.ts` turn constructors). Version 2
 * (#1315): intents name consumed inputs `deliveryIds`.
 */
import { z } from "zod";
import { RowBody, declare, refineField } from "../declaration.js";

/** Outcome of a recovered `tool.result` row that never executed. */
const ToolOutcome = z.enum(["interrupted"]);

export const turn = declare(
  "turn",
  RowBody.superRefine(refineField("intent", "consumedStale", z.array(z.string().min(1)))).superRefine(
    refineField("intent", "outcome", ToolOutcome),
  ),
  2,
);
