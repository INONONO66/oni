/**
 * `alarm` — one timer kind: `arm{purpose, at, supersedes, alarmId, sourceKey,
 * payload}` with `effect{occurrenceId}` and `fired{occurrenceId, outcome:
 * delivered|stale|exhausted}`; the former arm/fired/paused alarm kinds
 * collapse here (a paused monitor is a fired outcome `exhausted`). An
 * `at: null` arm retires the chain; `supersedes` names the previous
 * occurrence id the arm replaces. Single writer: the core timer
 * constructor (`packages/agent/src/core/ports/alarm.ts`).
 */
import { z } from "zod";
import { RowBody, declare, refineField } from "../declaration.js";

export const Op = z.enum(["arm", "fired"]);
export type Op = z.infer<typeof Op>;

export const FiredOutcome = z.enum(["delivered", "stale", "exhausted"]);
export type FiredOutcome = z.infer<typeof FiredOutcome>;

/**
 * The four loop-reserved alarm purposes (#1254): consumed by the core run
 * loop, never registrable by a capability or bundle — compose rejects them.
 */
export const RESERVED_PURPOSES = ["step_watchdog", "retry", "deadline", "resume"] as const;
export type ReservedPurpose = (typeof RESERVED_PURPOSES)[number];

export function isReservedPurpose(purpose: string): purpose is ReservedPurpose {
  return (RESERVED_PURPOSES as readonly string[]).includes(purpose);
}

export const alarm = declare(
  "alarm",
  RowBody.superRefine(refineField("intent", "op", Op))
    .superRefine(refineField("intent", "outcome", FiredOutcome))
    .superRefine(refineField("intent", "purpose", z.string().min(1)))
    .superRefine(refineField("intent", "at", z.number().nullable()))
    .superRefine(refineField("intent", "supersedes", z.string().min(1).nullable()))
    .superRefine(refineField("intent", "alarmId", z.string().min(1)))
    .superRefine(refineField("intent", "sourceKey", z.string().min(1)))
    .superRefine(refineField("intent", "occurrenceId", z.string().min(1)))
    .superRefine(refineField("effect", "occurrenceId", z.string().min(1))),
);
