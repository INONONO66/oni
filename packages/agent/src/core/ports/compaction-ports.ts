import type { Effect, Scope } from "effect";
import type {
  BusEvent,
  FoldCheckpoint,
  LedgerAction,
  Message,
  PlainValue,
} from "@openomni/protocol";
import { port, type PortTag } from "./capability";
import type { SessionKernel } from "../session/entity";
import type { AgentFailure, ContextRestoreError, ExecutionError } from "./failure";
import type { ExecutionRequest, Executor } from "../loop/executor";
import type { Entropy } from "./ports";
import type { RunState } from "../loop/turn";

/**
 * The ONE core-owned contract to the removable compaction plugin; with no service wired the kernel
 * skips compaction and records nothing — no built-in fallback.
 */
export const CompactionPort: PortTag = port("@openomni/compaction/Compaction");

export interface CompactionYield {
  readonly savedTokens: number;
  readonly tokensBefore: number;
}

export interface SummarizationBudget {
  /** Input bound applied only when the unchanged prefix does not fit beside the output reserve. */
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
  /** Receives the unchanged leading prefix when it fits, else the bounded input; merges into the previous anchor. */
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
 * `prepare` only starts speculation after a continuation; `threshold` is the after-turn check;
 * `yield` is the window yield and `overflow` the declared overflow. A pending speculative cut
 * can defer execution below grace for any execution reason.
 */
export type CompactionReason = "prepare" | "threshold" | "yield" | "overflow";

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

/** The composed service: the two run-free operations plus the binding that yields a run's port. */
export interface CompactionPortService {
  readonly pinAction: PinCompactionAction;
  readonly prepareRestore: PrepareCompactionRestore;
  /** Speculation lives in the run Scope; closing it settles the abort before the run returns. */
  readonly bind: (
    binding: CompactionRunBinding,
  ) => Effect.Effect<CompactionPort, never, Scope.Scope>;
}
