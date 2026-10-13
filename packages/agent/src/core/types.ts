import type { Effect } from "effect";
import type { ExecutionError } from "./failure";
import type {
  Actor,
  BusEvent,
  LedgerAction,
  Model,
  Message,
  PlainObject,
  PlainValue,
  Policy,
  Token,
  Tool,
} from "@openomni/protocol";
import type { RunInput } from "../model";
import type { CompactionOptions, CompactionSeamService } from "./compaction-ports";
import type { Executor } from "./gate/decide";

export type TokenUsage = Token.AgentUsage;

export type AgentBudget = Actor.Profile.Budget;

/**
 * A run budget with all four enforcement ceilings present (#1309): the loop
 * resolves the run's explicit `budget` against the injected approval policy's
 * `defaultBudget` once at entry, so the enforcement helpers read values, never
 * fall back to literals.
 */
export type ResolvedAgentBudget = AgentBudget &
  Required<Pick<AgentBudget, "maxTurns" | "maxToolCalls" | "maxWallTimeMs" | "maxToolRuntimeMs">>;

interface AgentExecutionLifecycle {
  judgeStop: import("./gate/decide").DurableExecutor["judgeStop"];
  runAttempts<T extends PlainValue>(
    parent: LedgerAction.Receipt,
    attempts: import("./gate/decide").LlmAttempts<T>,
  ): Effect.Effect<T, ExecutionError>;
}

type AgentToolSpec = Tool.Spec & {
  readonly descriptor?: Policy.Resource.Descriptor;
};

export interface ChatAgentConfig {
  /**
   * Required stop-evidence port: the turn consults it for progress, blocked,
   * and open-intent state before judging a stop; it has no empty default.
   */
  stopEvidence: () => Effect.Effect<{
    readonly progress: boolean;
    readonly blocked: boolean;
    readonly openIntent: readonly string[];
    readonly alarmIds: readonly string[];
  }, ExecutionError>;
  /** The session owns delivery claims; this loop invokes its three model-step boundaries. */
  boundary?: import("./run").SessionRunnerInput["boundary"];
  toolWave?: (calls: readonly Tool.Call[], signal?: AbortSignal) => Effect.Effect<readonly Tool.Result[], ExecutionError>;
  /** Durable L2 authority for session-owned prompt, turn, model, and tool work. */
  executor?: Executor;
  systemPrompt?: string;
  /** Durable child-action recorder, supplied only by the session composition. */
  execution?: AgentExecutionLifecycle;
  /** Direct, run-scoped history compaction strategy. */
  compaction?: CompactionOptions;
  /**
   * The composed compaction capability's verbs (#1307). Absent = the
   * capability is off: the loop runs without window-yield geometry, measured
   * context tracking, overflow estimates, or compaction itself — nothing is
   * recorded and nothing falls back.
   */
  compactionSeam?: CompactionSeamService;
  tools?: AgentToolSpec[];
  model: Model.Ref;
  /**
   * Ordered fallback models AFTER `model` (#752). On a chain-advancing
   * failure (timeout / transient_error / validation_error) the next retry
   * attempt resolves the next candidate via the pure model-layer
   * fold. Tool errors, context overflow (the compaction recovery retries the
   * SAME model), and aborts never advance the chain; when the chain is spent
   * the last candidate absorbs the remaining attempts — WHEN the run stops
   * retrying stays the retry policy's decision. Configuring a chain also
   * makes `validation_error` retryable (it is terminal without one: a
   * refusal/unusable shape only earns a retry when a DIFFERENT model can
   * answer it). Absent = every attempt uses `model`.
   */
  modelFallbacks?: Model.Ref[];
  /**
   * The model an earlier turn ended on (#970). When it is a configured
   * fallback, releasing it back to `model` is a recorded, policy-evaluated
   * `restore_model_selection` action at this turn's start; a refused
   * restoration keeps the fallback pinned for the turn.
   */
  pinnedModel?: Model.Ref;
  /**
   * Composition-owned release policy for a pinned fallback (#1276): the app
   * injects `restoreModelSelection` (apps/openomni/src/composition/
   * model-selection.ts). It returns the index in the model chain this turn
   * starts from. Absent = start at the primary without a recorded restoration.
   */
  restoreModelSelection?: (
    executor: Pick<Executor, "run">,
    pinned: Model.Ref | undefined,
    chain: readonly Model.Ref[],
  ) => Effect.Effect<number, ExecutionError>;
  budget?: AgentBudget;
  /**
   * The composed approval policy's default run budget (#1309): the resolved
   * values `budget` leaves unset. Required — the product bundle owns the
   * numbers and composition threads them; the core keeps no literal.
   */
  defaultBudget: ResolvedAgentBudget;
  onStepFinish?: (step: AgentStep) => Effect.Effect<void, ExecutionError>;
  toolExecutor?: (call: Tool.Call, context?: Tool.ExecutionContext) => Effect.Effect<Tool.Result, ExecutionError>;
  signal?: AbortSignal;
  /**
   * Provider-SDK options, forwarded verbatim to the llm call. JSON-shaped
   * but otherwise undescribed on purpose: the shape is the PROVIDER's, it
   * differs per provider and per SDK version, and no Zod schema in this repo
   * describes it. Validation is the host's — whoever reads the operator's
   * config owns rejecting a bad value; neither this loop nor the llm package
   * inspects it.
   */
  providerOptions?: PlainObject;
  auth?: RunInput["auth"];
  /**
   * Operator-supplied provider endpoint and headers, resolved by the host and
   * forwarded verbatim to every llm call this run makes. The loop never reads
   * it — it only carries it, the same way it carries `auth`.
   */
  transport?: RunInput["transport"];
  allowAuthFallback?: RunInput["allowAuthFallback"];
  toolChoice?: "auto" | "required" | "none";
  /**
   * Mid-turn steering port (#751): returns true while a host-side injection
   * is pending for this run. The loop checks it at step boundaries; when it
   * fires, the turn ends early so the pending message can enter history
   * through the existing `run.turn.post` continuation drain — the same seam
   * the injection queue already uses. Absent = turns never yield for
   * steering. A host that never clears its pending signal costs one model
   * step per turn until a budget bound ends the run — never an infinite loop.
   */
  steeringPending?: () => boolean;
}

/** Internal loop state captures observation delivery once at entry. */
export interface ObservedChatAgentConfig extends Omit<ChatAgentConfig, "budget" | "defaultBudget"> {
  readonly events: BusEvent.Sink;
  /** The run budget, fully resolved at loop entry (#1309). */
  readonly budget: ResolvedAgentBudget;
}

export interface ChatAgentInput {
  readonly history?: readonly import("@openomni/protocol").Message.WithParts[];
  /** The open turn's checkpointed budget counters; absent or null starts the run from zero. */
  readonly budgetState?: import("@openomni/protocol").FoldCheckpoint.BudgetState | null;
  /**
   * Hydrated history. `partMetadata`, when present, rides onto the rebuilt
   * text part verbatim — hydration must not strip structural identity
   * (compaction anchors carry theirs here; #702/#722 review: an anchor that
   * loses its metadata across resume breaks the merge chain and stacks
   * stale renders as pseudo-user messages).
   */
  messages: Array<
    | {
        role: "user";
        content: string;
        id?: string;
        partMetadata?: Message.TextPart["metadata"];
        time?: number;
      }
    | {
        role: "assistant";
        content: string;
        id?: string;
        partMetadata?: Message.TextPart["metadata"];
        time?: number;
      }
  >;
  traceContext?: import("@openomni/protocol").TraceContext.Type;
}

export interface AgentStep {
  type: "text";
  content: string;
}

export interface AgentResult {
  text: string;
  steps: AgentStep[];
  usage: TokenUsage;
  // The phantom "tool-calls"/"handoff" members (and handoffTarget) forced
  // every consumer to handle states that could not occur (#606 audit).
  finishReason: "stop" | "max-steps" | "stalled";
  waiting?: { readonly reason: "live_wait"; readonly alarmIds: readonly string[] };
  compactionCount?: number;
}
