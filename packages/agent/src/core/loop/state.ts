import { Message, type Policy, type TraceContext } from "@openomni/protocol";
import { stopState, type StopState } from "./stop";
import { accumulateUsage, type RunInput, type LlmSink as Sink } from "../ports/llm";
import { createBudgetState, recordTokenUsage, recordTurn, restoreBudgetState, type BudgetState, effectiveMaxToolCalls } from "./budget";
import { AgentInvariantViolation } from "../ports/failure";
import type { AgentResult, AgentStep, ChatAgentInput, TokenUsage, ObservedChatAgentConfig } from "../ports/types";
import { createUserMessage, createAssistantMessage, withMessageId, type MessageSource } from "../journal/message-factory";
import type { CompactionPort, CompactionYield } from "../ports/compaction-ports";
import * as Retry from "./retry";
import { buildSystemPrompt, prepareTurnTools } from "./tool";
import { measuredContextTokens } from "../ports/measure";

function toMessagesWithParts(
  messages: ChatAgentInput["messages"],
  sessionId: string,
  source: MessageSource,
): Message.WithParts[] {
  const output: Message.WithParts[] = [];

  for (const message of messages) {
    const parentID = output.at(-1)?.info.id ?? "";
    output.push(
      withMessageId(
        message.role === "user"
          ? createUserMessage(message.content, sessionId, source, message.partMetadata, message.time)
          : createAssistantMessage(
              message.content,
              parentID,
              sessionId,
              source,
              message.partMetadata,
              message.time,
            ),
        message.id,
      ),
    );
  }

  return output;
}

/** Every downstream stage takes this complete trace, so none handles a missing id. */
export type RunTrace = TraceContext.Type & {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId: string;
};

/**
 * Refuses an incomplete trace: ids invented on a run's behalf correlate to nothing.
 * Inheritance is required, not wire format — the emitter enforces `traceparent`.
 */
export function requireTrace(
  subject: string,
  traceContext: TraceContext.Type | undefined,
): RunTrace {
  const traceId = nonEmptyString(traceContext?.traceId);
  const sessionId = nonEmptyString(traceContext?.sessionId);
  const runId = nonEmptyString(traceContext?.runId);
  if (traceId === undefined || sessionId === undefined || runId === undefined) {
    const missing = [
      traceId === undefined ? "traceId" : undefined,
      sessionId === undefined ? "sessionId" : undefined,
      runId === undefined ? "runId" : undefined,
    ].filter((field: string | undefined): field is string => field !== undefined);
    throw new AgentInvariantViolation(`${subject} requires a trace context with ${missing.join(", ")}`);
  }
  return { ...traceContext, traceId, sessionId, runId };
}

export function nonEmptyString<T>(value: T): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface RunState {
  stop: StopState;
  readonly modelFailureReasons: string[];
  /** Chain index where selection starts (a pinned fallback the policy refused to release). */
  modelChainStart: number;
  modelKey?: string;
  readonly sessionId: string;
  budgetState: BudgetState;
  messages: Message.WithParts[];
  lastAssistantText: string;
  readonly steps: AgentStep[];
  readonly totalUsage: TokenUsage;
  continuationCount: number;
  compactionCount: number;
  /** Provider-measured context of the latest call; the compaction trigger reads this. */
  lastCallContextTokens?: number;
  /** One-shot overflow recovery: a provider overflow re-enters compaction at most once per run. */
  overflowCompactionAttempted?: boolean;
  /** The resolved model's context window; undefined when unknown (proxy models report 0). */
  contextWindowTokens?: number;
  /** Set when a window yield reclaimed nothing: re-yielding every step would kill a viable run. */
  windowYieldDisarmed?: boolean;
  /** Last committed structural yield; the policy and loop share its adaptive threshold. */
  lastCompactionYield?: CompactionYield;
  lastCompactionIneffective?: boolean;
  turnIndex: number;
  /** The last `turnIndex` charged to the budget; -1 before the first turn. */
  chargedTurnIndex: number;
  /** 1-based retry attempt: same `turnIndex` under a higher attempt is a re-entry, not progress. */
  attempt: number;
  readonly startTime: number;
}

export interface TurnArtifacts {
  readonly toolExecutor?: import("../ports/types").ChatAgentConfig["toolExecutor"];
  readonly runInput: RunInput;
  readonly trackingSink: Sink;
  /** The llm fold's latest boundary snapshot: the one source of what enters history at turn end. */
  readonly turnAssistant: { message?: Message.WithParts };
  readonly turnUsage: TokenUsage;
  readonly toolPolicyDecisions: Array<{ readonly decision: Policy.PolicyDecision }>;
  /** A turn that used its whole step budget ended on the cap, not a window yield. */
  readonly stepCap: number;
  /**
   * Mutable on purpose: a `model.override` reroutes after `buildTurn` planned, and turnYield must
   * classify against the call's real arm state.
   */
  windowYieldArmed: boolean;
  /** Yield disambiguator: a tool-calls stop below the step cap with this is a steering yield. */
  readonly steering: { requested: boolean };
}

export type BuildTurnResult =
  | { type: "ready"; turn: TurnArtifacts }
  | { type: "complete"; result: AgentResult };

export function createRunState(
  input: ChatAgentInput & { traceContext: RunTrace },
  source: MessageSource,
): RunState {
  const sessionId = input.traceContext.sessionId;
  return {
    sessionId,
    stop: stopState(),
    modelFailureReasons: [],
    modelChainStart: 0,
    budgetState:
      input.budgetState === undefined || input.budgetState === null
        ? createBudgetState(source.now)
        : restoreBudgetState(input.budgetState, source.now),
    messages:
      input.history === undefined
        ? toMessagesWithParts(input.messages, sessionId, source)
        : structuredClone([...input.history]),
    lastAssistantText: "",
    steps: [],
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    continuationCount: 0,
    compactionCount: 0,
    turnIndex: 0,
    chargedTurnIndex: -1,
    attempt: 1,
    startTime: source.now(),
  };
}

export function recordRunAttempt(state: RunState, attempt: number): void {
  state.attempt = attempt;
}

function getCompactionCount(state: RunState): number | undefined {
  return state.compactionCount > 0 ? state.compactionCount : undefined;
}

/**
 * Charged once per turn: a retried attempt re-enters without advancing `turnIndex`, so per-attempt
 * charging would let transient errors eat headroom.
 */
export function recordRunTurn(state: RunState): void {
  if (state.chargedTurnIndex === state.turnIndex) return;
  state.chargedTurnIndex = state.turnIndex;
  state.budgetState = recordTurn(state.budgetState);
}

export function recordCallContext(state: RunState, contextTokens: number): void {
  state.lastCallContextTokens = contextTokens;
}

export function recordRunWindow(state: RunState, contextWindowTokens: number): void {
  state.contextWindowTokens = contextWindowTokens > 0 ? contextWindowTokens : undefined;
}

export function disarmWindowYield(state: RunState): void {
  state.windowYieldDisarmed = true;
}

/**
 * The window guards are judgments about ONE model's window; carried onto a smaller fallback window
 * they would fire blind with the recovery already consumed.
 */
export function resetModelWindowGuards(state: RunState): void {
  state.windowYieldDisarmed = undefined;
  state.lastCompactionYield = undefined;
  state.lastCompactionIneffective = undefined;
  state.overflowCompactionAttempted = undefined;
}

function recordAssistantTokenDelta(
  state: RunState,
  usage: import("@openomni/protocol").Token.ProviderUsage,
): void {
  accumulateUsage(state.totalUsage, usage);
  state.budgetState = recordTokenUsage(state.budgetState, usage.inputTokens, usage.outputTokens);
}

function setLastAssistantText(state: RunState, text: string): void {
  state.lastAssistantText = text;
}

export function appendRunStep(state: RunState, step: AgentStep): void {
  state.steps.push(step);
}

export function appendRunMessages(state: RunState, messages: readonly Message.WithParts[]): void {
  state.messages.push(...messages);
}

export function advanceRunTurn(state: RunState): void {
  state.turnIndex++;
}

export function runResult(state: RunState, options?: { text?: string }): AgentResult {
  return {
    text: options?.text ?? state.lastAssistantText,
    steps: state.steps,
    usage: state.totalUsage,
    finishReason: "stop",
    compactionCount: getCompactionCount(state),
  };
}

export function assistantTextOf(message: Message.WithParts | undefined): string {
  if (message === undefined) return "";
  return message.parts
    .filter((part: Message.Part): part is Message.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function createTrackingSink(
  state: RunState,
  sink: Sink | undefined,
  turnUsage: TokenUsage,
  turnAssistant: TurnArtifacts["turnAssistant"],
): Sink {
  let prevInputTokens = 0;
  let prevOutputTokens = 0;
  let previousAux = { reasoning: 0, read: 0, write: 0 };
  return {
    onMessage(message) {
      if (message.info.role === "assistant") {
        // The latest immutable fold snapshot is the turn's only assistant source.
        turnAssistant.message = message;
        const tokens = message.info.tokens;
        const deltaInput = tokens.input - prevInputTokens;
        const deltaOutput = tokens.output - prevOutputTokens;
        prevInputTokens = tokens.input;
        prevOutputTokens = tokens.output;
        const delta = {
          inputTokens: deltaInput,
          outputTokens: deltaOutput,
          reasoningTokens: tokens.reasoning - previousAux.reasoning,
          cacheReadTokens: tokens.cache.read - previousAux.read,
          cacheWriteTokens: tokens.cache.write - previousAux.write,
        };
        previousAux = {
          reasoning: tokens.reasoning,
          read: tokens.cache.read,
          write: tokens.cache.write,
        };
        if (
          deltaInput > 0 ||
          deltaOutput > 0 ||
          delta.reasoningTokens > 0 ||
          delta.cacheReadTokens > 0 ||
          delta.cacheWriteTokens > 0
        ) {
          accumulateUsage(turnUsage, delta);
          recordAssistantTokenDelta(state, delta);
          const measured = measuredContextTokens(message);
          if (measured !== undefined) recordCallContext(state, measured);
        }
      }
      const text = assistantTextOf(message);
      if (text) setLastAssistantText(state, text);
      sink?.onMessage(message);
    },
    onToolCall: (call) => sink?.onToolCall(call),
    onToolResult: (result) => sink?.onToolResult(result),
  };
}

export function buildTurn(
  state: RunState,
  config: ObservedChatAgentConfig,
  providerModel: RunInput["model"],
  configuredToolChoice: RunInput["toolChoice"],
  trace: RunTrace,
  source: MessageSource,
  sink?: Sink,
  compaction?: CompactionPort,
): BuildTurnResult {
  recordRunTurn(state);
  if (config.signal?.aborted) throw Retry.abortError();

  const tools = prepareTurnTools(state, config);
  const system = buildSystemPrompt(config.systemPrompt, tools.allTools);
  const selectedTools = tools.allTools;

  const turnUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  // The session loop spends the remaining tool-call budget; provider I/O is one step.
  const toolCallPool = effectiveMaxToolCalls(config.budget);
  const stepCap =
    toolCallPool === -1
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, toolCallPool - state.budgetState.toolCalls);
  // No compaction port = the capability is off: the window-yield arm skips with it.
  const yieldAtInputTokens =
    state.windowYieldDisarmed === true ? undefined : compaction?.window(state)?.yieldAt;
  const turnAssistant: TurnArtifacts["turnAssistant"] = {};
  const trackingSink = createTrackingSink(state, sink, turnUsage, turnAssistant);
  // The host check is wrapped so the turn records WHY the loop stopped: without
  // the flag a steering yield below the step cap would terminate as "max-steps".
  const steering: TurnArtifacts["steering"] = { requested: false };
  const steeringPending = config.steeringPending;

  return {
    type: "ready",
    turn: {
      toolExecutor: tools.executor,
      runInput: {
        events: config.events,
        // ALIASING INVARIANT: this is `state.messages` itself, not a copy.
        // Effects that append to run history between here and the llm call
        // (prompt injections, continuation messages) are visible to this
        // turn's model input by design; effects that REPLACE history
        // (`replaceRunMessages`) swap the array and are deliberately NOT
        // visible to an already-built turn. Do not "fix" either direction.
        messages: state.messages,
        tools: selectedTools,
        system,
        signal: config.signal,
        model: providerModel,
        auth: config.auth,
        authProvider: config.model.provider,
        ...(config.transport === undefined ? {} : { transport: config.transport }),
        allowAuthFallback: config.allowAuthFallback,
        toolChoice: configuredToolChoice,
        // Yield at the compaction trigger's default ratio so the seam below gets its
        // chance on every path, not just injected continuations.
        ...(yieldAtInputTokens === undefined ? {} : { yieldAtInputTokens }),
        ...(steeringPending === undefined
          ? {}
          : {
              shouldYield: () => {
                if (!steeringPending()) return false;
                steering.requested = true;
                return true;
              },
            }),
        providerOptions: config.providerOptions,
        now: source.now,
        id: source.id,
        trace: { traceId: trace.traceId, sessionId: trace.sessionId, runId: trace.runId },
      },
      trackingSink,
      turnAssistant,
      turnUsage,
      stepCap,
      windowYieldArmed: yieldAtInputTokens !== undefined,
      steering,
      toolPolicyDecisions: [],
    },
  };
}
