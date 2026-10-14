/**
 * `llm` — one model call envelope and its attempt rows (`attempt` ordinal,
 * `generation`, usage, finishReason); the former `attempt` kind is a phase of
 * this kind. Single writer: the loop attempt recorder
 * (`packages/agent/src/core/loop/attempts.ts`).
 */
import { z } from "zod";
import { RowBody, declare, refineField } from "../declaration.js";

export const llm = declare(
  "llm",
  RowBody.superRefine(refineField("intent", "attempt", z.number().int().positive())).superRefine(
    refineField("intent", "generation", z.number().int().nonnegative()),
  ),
);
