import type { Message } from "@openomni/protocol";
import type { CompactionRecord } from "./durable";

// The option/budget shapes are seam types in `core/compaction-ports`; the
// old names stay as re-exports so the mechanism files stay put.
export type {
  CompactionOptions,
  ResolvedCompactionOptions,
  SummarizationBudget,
} from "../../core/api";
import type { CompactionExecutionOutcome } from "../../core/api";

/** The plugin's full result: the seam outcome plus mechanism-local fields. */
export interface CompactionResult extends CompactionExecutionOutcome {
  readonly record?: CompactionRecord;
  removedCount: number;
  /** L4: what happened to the speculative candidate, when one was offered. */
  candidate?: "promoted" | "discarded";
  /** Set when the trigger fired but no provider-valid cut exists: no summary
   * anchor and no user boundary at or before the cutoff. The caller records
   * it; killing the run over housekeeping would be worse than a full window. */
  blocked?: "no_user_boundary";
}

export type FinishCompaction = (
  result: CompactionResult,
  outcome: "cut" | "reduced" | "nothing_reclaimed" | "no_user_boundary",
  elidedChars: number,
  anchored?: boolean,
  summarizerError?: Error,
) => CompactionResult;

export interface ReducedHistory {
  readonly working: Message.WithParts[];
  readonly elidedChars: number;
  readonly completed?: CompactionResult;
}

export interface AnchoredCutAttempt {
  readonly cut?: CompactionResult;
  readonly summarizerError?: Error;
}

export const DEFAULT_PROTECT_RECENT = 6;

// ~20k tokens of verbatim user text carried through a cut (Codex ships the
// same order of magnitude). Strategy may narrow or widen it.
export const DEFAULT_PRESERVE_USER_CHARS = 80_000;
