import { z } from "zod";

export const RetryReason = z.enum([
  "timeout",
  "tool_error",
  "transient_error",
  "validation_error",
  "context_overflow",
]);
export type RetryReason = z.infer<typeof RetryReason>;

/**
 * `aborted` is not a `RetryReason`: an abort is an instruction to stop, never a fault to classify,
 * so it never appears on `agent.error.retry`.
 */
/** An honest absence, never defaulted to a transient claim. */
export type TerminalReason = RetryReason | "aborted" | "unclassified";

export const RunReasonCode = {
  /** The loop reports `stalled`, not a guard abort. */
  Stalled: "stalled",
  BudgetWarning: "budget_warning",
  BudgetReassurance: "budget_reassurance",
} as const;
