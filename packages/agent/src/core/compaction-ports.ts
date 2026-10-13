import type { Effect, Scope } from "effect";
import type {
  BusEvent,
  FoldCheckpoint,
  LedgerAction,
  Message,
  PlainValue,
} from "@openomni/protocol";
import { seam, type SeamTag } from "./capability";
import type { SessionKernel } from "./entity";
import type { AgentFailure, ContextRestoreError, ExecutionError } from "./failure";
import type { ExecutionRequest, Executor } from "./gate/decide";
import type { Entropy } from "./ports";
import type { RunState } from "./turn";

/**
 * The ONE core-owned contract to the removable compaction plugin; with no service wired the kernel
 * skips compaction and records nothing — no built-in fallback.
 */
export const CompactionSeam: SeamTag = seam("@openomni/compaction/Compaction");

export interface CompactionYield {
  readonly savedTokens: number;
  readonly tokensBefore: number;
}

export interface SummarizationBudget {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly contextWindowTokens: number;
}

export interface ToolOutputElision {
  readonly minOutputChars: number;
  readonly keepHeadChars: number;
}

export interface CompactionOptions {
  /** Narrows the recorded real window: compact as if the window were smaller. */
  contextWindowTokens?: number;
  reserveTokens?: number;
  protectRecentMessages?: number;
  /** Merges the newly cut span into the previous anchor body; it never regenerates. */
  onSummarize?: (
    messages: Message.WithParts[],
    previousAnchor: string | undefined,
    budget: SummarizationBudget,
    signal?: AbortSignal,
  ) => Effect.Effect<string, ExecutionError>;
  /** The newest user message is always kept, even alone over budget: it is irreplaceable. */
  preserveUserMessageChars?: number;
  /** Old tool outputs elide first; absent, the plugin applies its own defaults. */
  elideToolOutputs?: ToolOutputElision;
  /** Meaningful only with `onSummarize`: the summary runs in the background past the prepare ratio. */
  speculate?: false;
  /** Deterministic fallback after this. */
  summarizerDeadlineMs?: number;
}

/**
 * `threshold` is the automatic after-turn check; `yield` the window yield; `overflow` the port's
 * declared overflow. Only `threshold` may come back `skipped`, and only below threshold or disabled.
 */
export type CompactionReason = "threshold" | "yield" | "overflow";

/** `completed` settles the outcome into the run state; a rewrite shows as `compactionCount` growth. */
export type CompactionOutcome = "skipped" | "completed" | { readonly failed: ExecutionError };

/** Read-only window facts for yielding: where to yield and how to size a history without running. */
export interface CompactionWindow {
  readonly yieldAt: number;
  readonly measure: (messages: readonly Message.WithParts[]) => number;
}

export type PinCompactionAction = (
  kernel: SessionKernel,
  action: LedgerAction.Append,
  state: FoldCheckpoint.State,
  sourceRevision: number,
) => LedgerAction.Append;

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

export type PrepareCompactionRestore = (
  input: CompactionRestoreInput,
) => Effect.Effect<CompactionRestorePlan, ContextRestoreError | AgentFailure>;

/** The four operations the core consumes; everything else about compaction is the plugin's. */
export interface CompactionPort {
  readonly maybeCompact: (
    state: RunState,
    reason: CompactionReason,
  ) => Effect.Effect<CompactionOutcome, never, Entropy | Scope.Scope>;
  readonly window: (state: RunState) => CompactionWindow | undefined;
  readonly pinAction: PinCompactionAction;
  readonly prepareRestore: PrepareCompactionRestore;
}

/** What one run hands the plugin when binding its port. */
export interface CompactionRunBinding {
  readonly options: CompactionOptions | undefined;
  readonly identity: {
    readonly traceId: string;
    readonly sessionId: string;
    readonly runId?: string;
    readonly actorId?: string;
  };
  readonly events: BusEvent.Sink;
  readonly executor?: Executor;
  readonly signal?: AbortSignal;
}

/** The composed seam: the two run-free operations plus the binding that yields a run's port. */
export interface CompactionSeamService {
  readonly pinAction: PinCompactionAction;
  readonly prepareRestore: PrepareCompactionRestore;
  /** Speculation lives in the run Scope; closing it settles the abort before the run returns. */
  readonly bind: (
    binding: CompactionRunBinding,
  ) => Effect.Effect<CompactionPort, never, Scope.Scope>;
}
