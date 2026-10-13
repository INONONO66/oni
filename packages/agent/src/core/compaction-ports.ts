import type { Effect, Scope } from "effect";
import type { BusEvent, FoldCheckpoint, LedgerAction, Message, PlainValue } from "@openomni/protocol";
import { seam, type SeamTag } from "./capability";
import type { SessionKernel } from "./entity";
import type { AgentFailure, ContextRestoreError, ExecutionError } from "./failure";
import type { ExecutionRequest, Executor } from "./gate/decide";
import type { Entropy } from "./ports";

/**
 * The ONE core-owned contract to the removable compaction plugin; with no service wired the kernel
 * skips compaction and records nothing — no built-in fallback.
 */
export const CompactionSeam: SeamTag = seam("@openomni/compaction/Compaction");

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

/** Strategy data, so they arrive as config. */
export interface ToolOutputElision {
  readonly minOutputChars: number;
  readonly keepHeadChars: number;
}

export interface CompactionOptions {
  /** Narrows the recorded real window: compact as if the window were smaller. */
  contextWindowTokens?: number;
  reserveTokens?: number;
  protectRecentMessages?: number;
  /**
   * The summarizer merges the newly cut span into the previous anchor body; it never regenerates.
   * The mechanism owns the exclusions and threading.
   */
  onSummarize?: (
    messages: Message.WithParts[],
    previousAnchor: string | undefined,
    budget: SummarizationBudget,
    signal?: AbortSignal,
  ) => Effect.Effect<string, ExecutionError>;
  /** The newest user message is always kept, even alone over budget: it is irreplaceable. */
  preserveUserMessageChars?: number;
  /** Old tool outputs elide first; the lossy cut joins when the estimated reclaim cannot cover. */
  elideToolOutputs?: ToolOutputElision;
  /**
   * Meaningful only with `onSummarize`: the summary runs in the background past the prepare ratio
   * and promotes with zero model calls while its span is live.
   */
  speculate?: false;
  /** Deterministic fallback after this. */
  summarizerDeadlineMs?: number;
}

/** The mechanism never guesses the window. */
export type ResolvedCompactionOptions = CompactionOptions & { contextWindowTokens: number };

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

export interface CompactionRestoreInput {
  readonly sessionId: string;
  readonly compactionId: string;
  readonly action: LedgerAction.Node | undefined;
  readonly result: LedgerAction.Node | undefined;
  readonly history: readonly Message.WithParts[];
}

export interface CompactionRestorePlan {
  readonly request: ExecutionRequest;
  readonly restored: PlainValue;
}

/** Every member is the same function the plugin modules export. */
export interface CompactionSeamService {
  readonly protectRecent: number;
  readonly geometry: (input: CompactionGeometryInput) => CompactionGeometry;
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
  readonly pinAction: (
    kernel: SessionKernel,
    action: LedgerAction.Append,
    state: FoldCheckpoint.State,
    sourceRevision: number,
  ) => LedgerAction.Append;
  readonly prepareRestore: (
    input: CompactionRestoreInput,
  ) => Effect.Effect<CompactionRestorePlan, ContextRestoreError | AgentFailure>;
}
