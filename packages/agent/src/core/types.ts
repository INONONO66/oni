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

/** Resolved once at entry against the injected policy's `defaultBudget`, so enforcement reads values, never literals. */
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
  /** Required: consulted for progress, blocked and open-intent state before judging a stop; no empty default. */
  stopEvidence: () => Effect.Effect<{
    readonly progress: boolean;
    readonly blocked: boolean;
    readonly openIntent: readonly string[];
    readonly alarmIds: readonly string[];
  }, ExecutionError>;
  boundary?: import("./run").SessionRunnerInput["boundary"];
  toolWave?: (calls: readonly Tool.Call[], signal?: AbortSignal) => Effect.Effect<readonly Tool.Result[], ExecutionError>;
  executor?: Executor;
  systemPrompt?: string;
  execution?: AgentExecutionLifecycle;
  compaction?: CompactionOptions;
  /** Absent = the compaction capability is off: no window-yield geometry, context tracking or compaction; nothing falls back. */
  compactionSeam?: CompactionSeamService;
  tools?: AgentToolSpec[];
  model: Model.Ref;
  /**
     * Ordered fallbacks AFTER `model`: only timeout / transient_error /
     * validation_error advance the chain (a chain also makes validation_error
     * retryable); the last candidate absorbs remaining attempts. Absent = every attempt uses `model`.
     */
  modelFallbacks?: Model.Ref[];
  /** The model an earlier turn ended on; releasing a pinned fallback is a recorded, policy-evaluated `restore_model_selection` at turn start. */
  pinnedModel?: Model.Ref;
  /** App-injected release policy for a pinned fallback: returns the chain index this turn starts from. Absent = start at the primary. */
  restoreModelSelection?: (
    executor: Pick<Executor, "run">,
    pinned: Model.Ref | undefined,
    chain: readonly Model.Ref[],
  ) => Effect.Effect<number, ExecutionError>;
  budget?: AgentBudget;
  /** The values `budget` leaves unset; required — the product bundle owns the numbers, the core keeps no literal. */
  defaultBudget: ResolvedAgentBudget;
  onStepFinish?: (step: AgentStep) => Effect.Effect<void, ExecutionError>;
  toolExecutor?: (call: Tool.Call, context?: Tool.ExecutionContext) => Effect.Effect<Tool.Result, ExecutionError>;
  signal?: AbortSignal;
  /** Undescribed on purpose: the shape is the PROVIDER's and differs per SDK version; the host that reads operator config owns rejecting a bad value. */
  providerOptions?: PlainObject;
  auth?: RunInput["auth"];
  /** Forwarded verbatim to every llm call; the loop only carries it, like `auth`. */
  transport?: RunInput["transport"];
  allowAuthFallback?: RunInput["allowAuthFallback"];
  toolChoice?: "auto" | "required" | "none";
  /**
     * True while a host-side injection is pending: the turn ends at the next
     * step boundary so the message enters history through the `run.turn.post`
     * drain. A never-cleared signal costs one step per turn until a budget ends the run.
     */
  steeringPending?: () => boolean;
}

export interface ObservedChatAgentConfig extends Omit<ChatAgentConfig, "budget" | "defaultBudget"> {
  readonly events: BusEvent.Sink;
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
  // The phantom "tool-calls"/"handoff" members forced every consumer to handle
  // states that could not occur.
  finishReason: "stop" | "max-steps" | "stalled";
  waiting?: { readonly reason: "live_wait"; readonly alarmIds: readonly string[] };
  compactionCount?: number;
}
