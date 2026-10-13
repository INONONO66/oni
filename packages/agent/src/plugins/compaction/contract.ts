import type { Effect, Scope } from "effect";
import type { BusEvent, Message } from "@openomni/protocol";
import type { CompactionRecord } from "./durable";
import type {
  CompactionOptions,
  CompactionYield,
  Executor,
  ToolOutputElision,
} from "../../core/api";

export type { CompactionOptions, CompactionYield, SummarizationBudget } from "../../core/api";

/** The mechanism never guesses the window. */
export type ResolvedCompactionOptions = CompactionOptions & { contextWindowTokens: number };

export interface CompactionGeometryInput {
  readonly contextWindowTokens: number;
  readonly reserveTokens?: number;
  readonly previousYield?: CompactionYield;
}

export interface CompactionGeometry {
  readonly thresholdRatio: number;
  readonly thresholdTokens: number;
  readonly reserveTokens: number;
  readonly leadTokens: number;
  readonly prepareTokens: number;
  readonly graceTokens: number;
}

/** Pinned to the cut anchor, not to later appends. */
export interface CompactionCandidate {
  readonly prefixIds: readonly string[];
  readonly prefixFingerprint: string;
  readonly firstKeptId: string;
  readonly compactionAnchorId: string | undefined;
  readonly anchorBody: string;
}

export interface CompactionSessionPort {
  prepare(
    messages: readonly Message.WithParts[],
    contextTokens: number,
    prepareTokens: number,
    contextWindowTokens: number,
    onFailure?: (error: Error, failureStreak: number) => void,
  ): Effect.Effect<void, never, Scope.Scope>;
  candidate(): CompactionCandidate | undefined;
  inFlight(): boolean;
  consume(): void;
  disable(): Effect.Effect<void>;
  settleAbort(): Effect.Effect<void>;
}

export interface CompactionSessionConfig {
  readonly protectRecentMessages: number;
  readonly summarize: NonNullable<CompactionOptions["onSummarize"]>;
  readonly summarizerDeadlineMs?: number;
}

export interface CompactionExecutionInput {
  readonly history: Message.WithParts[];
  readonly options: ResolvedCompactionOptions;
  readonly identity: {
    readonly traceId: string;
    readonly sessionId: string;
    readonly runId?: string;
    readonly actorId?: string;
  };
  readonly events: BusEvent.Sink;
  readonly executor?: Executor;
  readonly signal?: AbortSignal;
  readonly dispatch: {
    readonly trigger: "threshold" | "yield";
    readonly measuredTokens?: number;
    readonly candidate?: CompactionCandidate;
  };
}

export interface CompactionExecutionOutcome {
  compacted: boolean;
  messages: Message.WithParts[];
  summarizerFailed?: boolean;
  yield?: CompactionYield;
  ineffective?: boolean;
}

/** The plugin's full result: the execution outcome plus mechanism-local fields. */
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

/** Old tool outputs past this size elide first, keeping a head excerpt the model can recall by. */
export const DEFAULT_TOOL_OUTPUT_ELISION: ToolOutputElision = Object.freeze({
  minOutputChars: 4000,
  keepHeadChars: 500,
});
