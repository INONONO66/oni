import type { Effect, Scope } from "effect";
import type { BusEvent, FoldCheckpoint, LedgerAction, Message, PlainValue } from "@openomni/protocol";
import { seam, type SeamTag } from "./capability";
import type { SessionKernel } from "./entity";
import type { AgentFailure, ContextRestoreError, ExecutionError } from "./failure";
import type { ExecutionRequest, Executor } from "./gate/decide";
import type { Entropy } from "./ports";

/**
 * The compaction seam (#1307): the ONE core-owned contract through which the
 * kernel reaches the removable compaction capability plugin. The core
 * declares these types and reads a composed {@link CompactionSeamService};
 * it never imports a plugin file. When no service is wired (the capability
 * is off) the kernel skips compaction and records nothing new — it does not
 * fall back to a built-in copy.
 */
export const CompactionSeam: SeamTag = seam("@openomni/compaction/Compaction");

/** The structural yield of one committed compaction, feeding the next geometry decision. */
export interface CompactionYield {
  readonly savedTokens: number;
  readonly tokensBefore: number;
}

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

export interface SummarizationBudget {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly contextWindowTokens: number;
}

/** Deterministic tool-output elision knobs — strategy data, so they arrive as config. */
export interface ToolOutputElision {
  /** Outputs at or below this length are left alone — nothing worth reclaiming. */
  readonly minOutputChars: number;
  /** How much of the head survives as an excerpt, so the record still says what happened. */
  readonly keepHeadChars: number;
}

export interface CompactionOptions {
  /**
   * Optional narrowing of the model's window. The loop records the resolved
   * model's real limit and the policy reads it from the dispatch context, so
   * strategy config only sets this to compact as if the window were smaller.
   */
  contextWindowTokens?: number;
  /** Minimum headroom reserved beyond the adaptive threshold. */
  reserveTokens?: number;
  protectRecentMessages?: number;
  /**
   * Anchored iterative summarization (compaction-design L2). The summarizer
   * receives the newly cut span WITH user messages and prior anchor renders
   * already excluded, plus the previous anchor body when one exists — it
   * merges, it never regenerates. The mechanism owns the exclusions and the
   * threading; what the summarizer does with them is strategy.
   */
  onSummarize?: (
    messages: Message.WithParts[],
    previousAnchor: string | undefined,
    budget: SummarizationBudget,
    signal?: AbortSignal,
  ) => Effect.Effect<string, ExecutionError>;
  /**
   * Budget (chars) of most-recent user messages carried verbatim through a
   * cut. The newest user message is always preserved even when it alone
   * exceeds the budget — user tokens are the irreplaceable part.
   */
  preserveUserMessageChars?: number;
  /**
   * Opt-in deterministic reduction: when the trigger fires, old completed
   * tool outputs are elided first; the lossy cut joins the same round
   * whenever the estimated net reclaim cannot cover the measured overage.
   * The knobs are strategy, so they arrive as config.
   */
  elideToolOutputs?: ToolOutputElision;
  /**
   * Speculative prepare/promote (L4). Meaningful only with `onSummarize`:
   * once the measured window passes the prepare ratio the summarize call
   * runs in the background at turn settlement, and the seam promotes the
   * result with zero model calls while its span is still live. `false`
   * disables speculation; the seam then always merges synchronously.
   */
  speculate?: false;
  /** Maximum duration of each summarizer call before deterministic fallback. */
  summarizerDeadlineMs?: number;
}

/** Options with the window already resolved — the mechanism never guesses it. */
export type ResolvedCompactionOptions = CompactionOptions & { contextWindowTokens: number };

/** A warm speculative summary pinned to the cut anchor, not to later appends. */
export interface CompactionCandidate {
  readonly prefixIds: readonly string[];
  readonly prefixFingerprint: string;
  readonly firstKeptId: string;
  readonly compactionAnchorId: string | undefined;
  readonly anchorBody: string;
}

/** The speculative-session face the run loop holds; the plugin owns the class. */
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

/** Exactly the fields of the plugin's execution result the kernel reads. */
export interface CompactionExecutionOutcome {
  compacted: boolean;
  messages: Message.WithParts[];
  summarizerFailed?: boolean;
  yield?: CompactionYield;
  ineffective?: boolean;
}

export interface CompactionRestoreInput {
  readonly sessionId: string;
  readonly compactionId: string;
  /** `kernel.actionById(compactionId)` — the compaction intent to restore from. */
  readonly action: LedgerAction.Node | undefined;
  /** `kernel.resultFor(sessionId, compactionId)` — its executed result child. */
  readonly result: LedgerAction.Node | undefined;
  /** The session's current hydrated projection. */
  readonly history: readonly Message.WithParts[];
}

export interface CompactionRestorePlan {
  readonly request: ExecutionRequest;
  readonly restored: PlainValue;
}

/**
 * The frozen service object the compaction capability publishes as its verbs
 * (#1307). Composition wires it into `SessionRuntime.compaction` (kernel
 * commit/restore paths) and `ChatAgentConfig.compactionSeam` (run loop);
 * every member is the same function the plugin modules export.
 */
export interface CompactionSeamService {
  /** Default protected tail width (`DEFAULT_PROTECT_RECENT`). */
  readonly protectRecent: number;
  readonly geometry: (input: CompactionGeometryInput) => CompactionGeometry;
  /** Provider-measured context of a turn's final model call, or undefined. */
  readonly measure: (message: Message.WithParts) => number | undefined;
  readonly estimate: (messages: readonly Message.WithParts[]) => number;
  readonly shouldCompact: (
    totalTokens: number,
    options: ResolvedCompactionOptions,
    previousYield?: CompactionYield,
  ) => boolean;
  readonly execute: (
    input: CompactionExecutionInput,
  ) => Effect.Effect<CompactionExecutionOutcome, ExecutionError, Entropy>;
  readonly createSession: (config: CompactionSessionConfig) => CompactionSessionPort;
  /** Decorates a compaction journal action with its successor proof at commit. */
  readonly pinAction: (
    kernel: SessionKernel,
    action: LedgerAction.Append,
    state: FoldCheckpoint.State,
    sourceRevision: number,
  ) => LedgerAction.Append;
  /** Builds the typed `restore_context_projection` request and its restored value. */
  readonly prepareRestore: (
    input: CompactionRestoreInput,
  ) => Effect.Effect<CompactionRestorePlan, ContextRestoreError | AgentFailure>;
}
