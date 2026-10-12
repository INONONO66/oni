import { type BusEvent, Message, type Policy, type TraceContext, Operational, PlainValueSchema, type PlainValue } from "@openomni/protocol";
import { Effect, Clock, Scope, Cause, Context } from "effect";
import { stopState, type StopState, type StopVerdict } from "./stop";
import { RunEvents } from "./run-events";
export { stopState } from "./stop";
export type { StopObservation, StopVerdict } from "./stop";
export { RunEvents } from "./run-events";
import { accumulateUsage, type RunInput, type Sink, type LlmError, Llm, Retry as LlmRetry, LlmRunFailure, observeRetry, selectModel } from "../model";
import { createBudgetState, recordTokenUsage, recordTurn, resolveAgentBudget, type BudgetState, effectiveMaxToolCalls, publishBudgetTelemetry, evaluateBudget } from "./budget";
import { AgentStopError, AgentInvariantViolation, AgentFailure, type ExecutionError, Interrupted, ContextAdmissionError, renderBodyCause, thrownAsError } from "./failure";
import type { AgentResult, AgentStep, ChatAgentInput, TokenUsage, ChatAgentConfig, ObservedChatAgentConfig } from "./types";
import { createUserMessage, createAssistantMessage, withMessageId, type MessageSource } from "./message-factory";
import type { CompactionSessionPort, CompactionYield } from "./compaction-ports";
import * as Retry from "./retry";
import { type RetryReason, type TerminalReason, failureFacts } from "./retry";
import { buildSystemPrompt, prepareTurnTools, settleModelTools, assertToolExecutor, assertUnambiguousToolMetadata } from "./tool";
import { Entropy, ObservationSink } from "./ports";
import { applyCompaction, prepareCompactionAfterContinue } from "./compaction";
import { ExecutorContext, type Executor } from "./gate/decide";


// ─── from core/execution/state.ts (#1247) ───
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

/**
 * A run's trace context after the runner has refused an incomplete one. The
 * three ids are inherited from whatever asked for the run; every downstream
 * stage takes this type rather than the partial one, so none of them has to
 * decide what to do about a missing id.
 */
export type RunTrace = TraceContext.Type & {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId: string;
};

/**
 * Builds a {@link RunTrace}, refusing an incomplete one.
 *
 * A run or a tool call whose traceId, sessionId, and runId were invented on
 * its behalf emits records that correlate to nothing, and the caller never
 * learns it forgot (#606). `subject` names the boundary that refused, and the
 * message lists what was missing rather than only that something was.
 *
 * What is required is inheritance, not wire format. Whether the identity is
 * expressible as a W3C `traceparent` is enforced by the emitter that puts it
 * on the wire, which is the only place the format matters.
 */
function requireTrace(
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

function nonEmptyString<T>(value: T): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A run's identity, all four fields required. The runner builds exactly one of
 * these, from a trace it refused to mint (#606); nothing else may synthesize
 * one, so every consumer can read the fields rather than guess at them.
 */
export interface AgentRunBase {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly actorId: string;
}

export interface RunState {
  stop: StopState;
  readonly modelFailureReasons: string[];
  /** Index into the configured chain where this turn's selection starts (a pinned fallback the policy refused to release). */
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
  /**
   * Provider-measured context of the most recent model call
   * (input + cache read + cache write), undefined until one completes.
   * The compaction trigger reads this — never the cumulative run spend.
   */
  lastCallContextTokens?: number;
  /**
   * L5: the one-shot overflow recovery. A provider context-overflow may
   * re-enter the compaction seam and retry exactly once per run; a second
   * overflow ends the run honestly.
   */
  overflowCompactionAttempted?: boolean;
  /**
   * The resolved model's context window — a fact of the model, recorded when
   * the loop resolves it, so strategy config never has to re-derive it.
   * Undefined when the catalog does not know (proxy models report 0).
   */
  contextWindowTokens?: number;
  /**
   * Set when a window yield fired and the seam reclaimed nothing: the run
   * proceeds with the yield disarmed — the remaining headroom is real, and
   * re-yielding every step would kill a run the window could still carry.
   */
  windowYieldDisarmed?: boolean;
  /** Last committed structural yield; the policy and loop share its adaptive threshold. */
  lastCompactionYield?: CompactionYield;
  /** Results of the most recent apply seam, consumed by the window-yield path. */
  lastCompactionIneffective?: boolean;
  turnIndex: number;
  /** The last `turnIndex` charged to the budget; -1 before the first turn. */
  chargedTurnIndex: number;
  /**
   * The current retry attempt (1-based), stamped by the runner at each
   * attempt's start. Together with `turnIndex` it gives lifecycle policies an
   * attempt-scoped identity: the same turnIndex under a higher attempt is a
   * retry re-entry, never progress (#694 observation material).
   */
  attempt: number;
  readonly startTime: number;
}

export interface TurnArtifacts {
  readonly toolExecutor?: import("./types").ChatAgentConfig["toolExecutor"];
  readonly runInput: RunInput;
  readonly trackingSink: Sink;
  /**
   * The turn's assistant message as projected by the llm fold (#557): the
   * latest boundary snapshot, immutable, with all parts (tool + reasoning
   * included). This is the single source of truth for what enters history
   * at turn end (#546).
   */
  readonly turnAssistant: { message?: Message.WithParts };
  readonly turnUsage: TokenUsage;
  readonly toolPolicyDecisions: Array<{ readonly decision: Policy.PolicyDecision }>;
  /** The step budget this turn was given — a turn that used all of it ended on the cap, not a window yield. */
  readonly stepCap: number;
  /**
   * Whether the window-yield knob was armed for the call that actually ran.
   * Mutable on purpose: a `model.override` (#753) reroutes the connection
   * after buildTurn planned it, and turnYield must classify the stop against
   * the call's real arm state, not the plan's.
   */
  windowYieldArmed: boolean;
  /**
   * Set when the host steering check fired at a step boundary (#751) — the
   * yield disambiguator: a tool-calls stop below the step cap with this set
   * is a steering yield, not a cap end or a window yield.
   */
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
    budgetState: createBudgetState(source.now),
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

function recordRunAttempt(state: RunState, attempt: number): void {
  state.attempt = attempt;
}

function getCompactionCount(state: RunState): number | undefined {
  return state.compactionCount > 0 ? state.compactionCount : undefined;
}

/**
 * Charges the turn budget for the turn about to run, once.
 *
 * A retried attempt is the same turn tried again: the runner re-enters
 * `buildTurn` without advancing `turnIndex`, so charging per attempt would let
 * a transient provider error eat headroom an operator sized in turns of work.
 */
export function recordRunTurn(state: RunState): void {
  if (state.chargedTurnIndex === state.turnIndex) return;
  state.chargedTurnIndex = state.turnIndex;
  state.budgetState = recordTurn(state.budgetState);
}

export function recordCallContext(state: RunState, contextTokens: number): void {
  state.lastCallContextTokens = contextTokens;
}

function recordRunWindow(state: RunState, contextWindowTokens: number): void {
  state.contextWindowTokens = contextWindowTokens > 0 ? contextWindowTokens : undefined;
}

function disarmWindowYield(state: RunState): void {
  state.windowYieldDisarmed = true;
}

/**
 * Clears the model-scoped window guards on a fallback model switch (#752
 * review F3). `windowYieldDisarmed` ("the remaining headroom is real") and
 * the spent L5 one-shot overflow recovery are judgments about ONE model's
 * window; carried onto a different model, a smaller fallback window would be
 * fired blind with its recovery already consumed.
 */
function resetModelWindowGuards(state: RunState): void {
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

function appendRunStep(state: RunState, step: AgentStep): void {
  state.steps.push(step);
}

function appendRunMessages(state: RunState, messages: readonly Message.WithParts[]): void {
  state.messages.push(...messages);
}

export function advanceRunTurn(state: RunState): void {
  state.turnIndex++;
}

// ─── from core/execution/run-events.ts (#1247) ───
function emitRunStarted(
  events: BusEvent.Sink,
  trace: TraceContext.Type,
  modelId: string,
  now: () => number,
): void {
  events.publish(Operational.Events.Info, {
    traceId: trace.traceId,
    time: now(),
    sessionId: trace.sessionId,
    component: "agent",
    msg: "agent.run.started",
    context: { model: modelId },
  });
}

function emitTurnStart(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  now: () => number,
): void {
  events.publish(RunEvents.TurnStart, {
    ...agentBase,
    time: now(),
    turnIndex: state.turnIndex,
  });
}

function emitTurnComplete(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  turnUsage: TokenUsage,
  now: () => number,
): void {
  events.publish(RunEvents.TurnComplete, {
    ...agentBase,
    time: now(),
    turnIndex: state.turnIndex,
    usage: {
      inputTokens: turnUsage.inputTokens,
      outputTokens: turnUsage.outputTokens,
      totalTokens: turnUsage.totalTokens,
    },
  });
}

function emitRunCompleted(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  finishReason: AgentResult["finishReason"],
  now: () => number,
): void {
  const time = now();
  events.publish(Operational.Events.Info, {
    traceId: agentBase.traceId,
    time,
    sessionId: agentBase.sessionId,
    component: "agent",
    msg: "agent.run.completed",
    context: {
      finishReason,
      turns: state.budgetState.turns,
      durationMs: time - state.startTime,
    },
  });
}

function emitErrorRetry(
  events: BusEvent.Sink,
  agentBase: AgentRunBase,
  options: {
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly error: string;
    readonly reason: RetryReason;
    readonly backoffMs: number;
  },
  now: () => number,
): void {
  events.publish(RunEvents.ErrorRetry, {
    ...agentBase,
    time: now(),
    attempt: options.attempt,
    maxAttempts: options.maxAttempts,
    error: options.error,
    reason: options.reason,
    backoffMs: options.backoffMs,
  });
}

/**
 * The run is over and will not be retried.
 *
 * `reason` and `maxAttempts` are carried because on a first-attempt terminal
 * failure no `ErrorRetry` precedes this, and the effective `maxAttempts` — the
 * configured one narrowed by a `run.retry_after` effect — exists nowhere else
 * in the record.
 */
function emitRunFailed(
  events: BusEvent.Sink,
  agentBase: AgentRunBase,
  error: string,
  decision: {
    readonly reason: TerminalReason;
    readonly attempt: number;
    readonly maxAttempts: number;
  },
  now: () => number,
): void {
  events.publish(Operational.Events.Error, {
    traceId: agentBase.traceId,
    time: now(),
    sessionId: agentBase.sessionId,
    component: "agent",
    msg: "agent.run.failed",
    error,
    context: { ...decision },
  });
}

function runResult(state: RunState, options?: { text?: string }): AgentResult {
  return {
    text: options?.text ?? state.lastAssistantText,
    steps: state.steps,
    usage: state.totalUsage,
    finishReason: "stop",
    compactionCount: getCompactionCount(state),
  };
}

// ─── from core/execution/turn-assistant.ts (#1247) ───
function assistantTextOf(message: Message.WithParts | undefined): string {
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
  measure: ((message: Message.WithParts) => number | undefined) | undefined,
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
          const measured = measure?.(message);
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

function recordAssistant(
  config: ObservedChatAgentConfig,
  message: Message.WithParts,
): Effect.Effect<Message.WithParts, ExecutionError> {
  return Effect.gen(function* () {
  if (config.executor === undefined) return yield* Effect.die(new Error("missing message authority"));
  const result = yield* config.executor.run(
    { kind: "message", op: "assistant", intent: { messageId: message.info.id }, effect: {} },
    () => Effect.sync(() => PlainValueSchema.parse(message)),
  );
  if (result.terminal !== "executed")
    return yield* new AgentFailure({ operation: "message.assistant", cause: `refused:${result.reason}` });
  return Message.WithParts.parse(result.value);
  });
}

// ─── from core/execution/turn.ts (#1247) ───
export function buildTurn(
  state: RunState,
  config: ObservedChatAgentConfig,
  providerModel: RunInput["model"],
  configuredToolChoice: RunInput["toolChoice"],
  trace: RunTrace,
  source: MessageSource,
  sink?: Sink,
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
  // No compaction seam = the capability is off: the window-yield arm and the
  // measured-context recording are compaction concerns and skip with it (#1307).
  const compactionSeam = config.compactionSeam;
  const yieldAtInputTokens =
    state.contextWindowTokens === undefined ||
    state.windowYieldDisarmed === true ||
    compactionSeam === undefined
      ? undefined
      : Math.floor(
          compactionSeam.geometry({
            contextWindowTokens: state.contextWindowTokens,
            ...(state.lastCompactionYield === undefined
              ? {}
              : { previousYield: state.lastCompactionYield }),
          }).thresholdTokens,
        );
  const turnAssistant: TurnArtifacts["turnAssistant"] = {};
  const trackingSink = createTrackingSink(state, sink, turnUsage, turnAssistant, compactionSeam?.measure);
  // Steering (#751): the host check is wrapped so the turn records WHY the
  // loop stopped — without the flag, a steering yield below the step cap is
  // indistinguishable from a cap end and would terminate as "max-steps".
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
        // Yield at the same ratio the compaction trigger defaults to: the
        // loop stops at a step boundary once the window fills, the seam
        // below gets its chance on every path — Resident and tool loops
        // included, not just injected continuations (#649 reachability map).
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

type StopOutcome = AgentResult | "continue";

/**
 * A turn whose last step still asked for tools did not finish — the llm loop
 * stopped it: at the step cap, or at the window-yield boundary the loop arms
 * from the recorded model window. Anything else is the model's own stop.
 */
function turnYield(
  turn: TurnArtifacts,
  assistantMessage: Message.WithParts,
): "window" | "steps" | "steer" | null {
  let steps = 0;
  let lastReason: string | undefined;
  for (const part of assistantMessage.parts) {
    if (part.type === "step-finish") {
      steps += 1;
      lastReason = part.reason;
    }
  }
  if (lastReason !== "tool-calls") return null;
  if (steps >= turn.stepCap) return "steps";
  // The cap outranks steering: a turn that spent its whole step budget ended
  // on the cap even if the steering check also fired — "max-steps" stays the
  // honest terminal. Steering outranks the window: the pending message should
  // reach the model next turn; a still-full window re-arms and yields again.
  if (turn.steering.requested) return "steer";
  return turn.windowYieldArmed ? "window" : "steps";
}

function handleStop(
  state: RunState,
  config: ObservedChatAgentConfig,
  execution: NonNullable<ObservedChatAgentConfig["execution"]>,
  agentBase: AgentRunBase,
  turn: TurnArtifacts,
  compaction: CompactionSessionPort | undefined,
): Effect.Effect<StopOutcome, ExecutionError, Scope.Scope | Entropy> {
  return Effect.gen(function* () {
  const now = yield* Clock.clockWith(Effect.succeed).pipe(
    Effect.map((clock) => (): number => clock.currentTimeMillisUnsafe()),
  );
  const assistantIndex = state.messages.length;
  const snapshot = turn.turnAssistant.message;
  // The llm fold owns the turn snapshot; its absence is a wiring defect, not a recoverable state.
  if (snapshot === undefined)
    return yield* Effect.die(new AgentInvariantViolation("llm sink emitted no assistant snapshot"));
  const initialAssistant = yield* recordAssistant(config, snapshot);
  turn.turnAssistant.message = initialAssistant;
  appendRunMessages(state, [initialAssistant]);
  const afterModelPrompts = yield* drainStepBoundary(state, config, "after_llm");
  const toolCalls = yield* settleModelTools(turn, config, state);
  const afterWavePrompts = yield* drainStepBoundary(state, config, "after_tools");
  if (toolCalls > 0)
    turn.turnAssistant.message = yield* recordAssistant(
      config,
      turn.turnAssistant.message ?? initialAssistant,
    );
  emitTurnComplete(config.events, state, agentBase, turn.turnUsage, now);
  const turnText = assistantTextOf(turn.turnAssistant.message);
  const step = { type: "text" as const, content: turnText };
  appendRunStep(state, step);
  if (config.onStepFinish) yield* config.onStepFinish(step);
  const assistantMessage = turn.turnAssistant.message ?? initialAssistant;
  state.messages[assistantIndex] = assistantMessage;
  yield* prepareCompactionAfterContinue(state, config, compaction);

  const yielded = toolCalls > 0 ? null : turnYield(turn, assistantMessage);
  const compacted = yield* applyCompaction(
    state,
    config,
    agentBase,
    compaction,
    yielded === "window" ? "yield" : "threshold",
  );
  if (yielded === "window" && (compacted === "none" || state.lastCompactionIneffective))
    disarmWindowYield(state);
  const evidence = yield* config.stopEvidence();
  const judgment = yield* execution.judgeStop(state.stop, {
    ...evidence,
    text: turnText,
    toolCalls,
    continueRequested:
      yielded === "window" || yielded === "steer" || afterModelPrompts + afterWavePrompts > 0,
    interrupted: config.signal?.aborted === true,
    exhausted:
      yielded === "steps" ||
      publishBudgetTelemetry(state.budgetState, agentBase, config.events, now, config.budget) ===
        "exceeded",
  });
  state.stop = judgment.state;
  return yield* stopResult(state, turnText, judgment.verdict);
  });
}

function stopResult(state: RunState, text: string, verdict: StopVerdict): Effect.Effect<StopOutcome, Interrupted | AgentStopError> {
  if (verdict.kind === "interrupted") return Effect.fail(new Interrupted());
  if (verdict.kind === "error") return Effect.fail(new AgentStopError({ reason: verdict.reason }));
  if (verdict.kind === "continue") {
    advanceRunTurn(state);
    return Effect.succeed("continue");
  }
  const result = runResult(state, { text });
  return Effect.succeed(verdict.kind === "waiting"
    ? { ...result, waiting: { reason: "live_wait", alarmIds: verdict.alarmIds } }
    : result);
}

function handleContinue(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  turnUsage: TokenUsage,
  now: () => number,
): void {
  emitTurnComplete(events, state, agentBase, turnUsage, now);
  advanceRunTurn(state);
}

function drainStepBoundary(
  state: RunState,
  config: ObservedChatAgentConfig,
  boundary: "before_llm" | "after_llm" | "after_tools",
): Effect.Effect<number, ExecutionError, Entropy> {
  if (config.boundary === undefined) return Effect.suspend(() =>
    config.signal?.aborted ? Effect.fail(new Interrupted()) : Effect.succeed(0));
  return Effect.gen(function* () {
  const drained = yield* (config.boundary?.(boundary) ?? Effect.succeed(undefined));
  if (drained?.interrupted || config.signal?.aborted) return yield* Effect.fail(new Interrupted());
  const { id } = yield* Entropy;
  const created = yield* Clock.currentTimeMillis;
  for (const message of drained?.messages ?? []) {
    appendRunMessages(state, [
      withMessageId(createUserMessage(message.text, state.sessionId, { now: () => created, id }), message.id),
    ]);
  }
  return drained?.messages.length ?? 0;
  });
}

// ─── from core/execution/run.ts (#1247) ───
/** Stateless L3 orchestration; the session supplies the only execution authority. */
export function runAgent(
  input: ChatAgentInput,
  options: ChatAgentConfig,
  sink?: Sink,
): Effect.Effect<AgentResult, ExecutionError, Llm | ObservationSink | Entropy> {
  return Effect.gen(function* () {
  const llm = yield* Llm;
  const events = yield* ObservationSink;
  const clock = yield* Clock.clockWith(Effect.succeed);
  const entropy = yield* Entropy;
  const now = (): number => clock.currentTimeMillisUnsafe();
  const source: MessageSource = { now, id: entropy.id };
  const config = {
    ...options,
    events,
    // #1309: resolve the run budget once at entry — the explicit budget wins
    // per field; the rest reads the injected policy's defaultBudget.
    budget: resolveAgentBudget(options.defaultBudget, options.budget),
  };
  return yield* Effect.scopedWith((scope) => Effect.suspend(() => {
  const trace = requireTrace("agent run", input.traceContext);
  assertToolExecutor(config);
  assertUnambiguousToolMetadata(config);
  const durableExecutor = config.executor;
  if (durableExecutor === undefined || config.execution === undefined)
    return Effect.die(new Error("agent run requires session execution authority"));
  const execution = config.execution;
  const state = createRunState({ ...input, traceContext: trace }, source);
  const base = {
    traceId: trace.traceId,
    sessionId: trace.sessionId,
    runId: trace.runId,
    actorId: nonEmptyString(trace.agentName) ?? trace.runId,
  };
  const compaction = createCompactionSession(config);
  emitRunStarted(config.events, trace, config.model.id, now);
  const needsExecutorContext = (config.tools?.length ?? 0) > 0 ||
    config.toolExecutor !== undefined || config.toolWave !== undefined;
  const runContext = needsExecutorContext
    ? Context.make(ExecutorContext, durableExecutor).pipe(Context.add(Scope.Scope, scope))
    : Context.make(Scope.Scope, scope);
  return Effect.gen(function* () {
    state.modelChainStart = yield* config.restoreModelSelection?.(durableExecutor, config.pinnedModel, [
      config.model,
      ...(config.modelFallbacks ?? []),
    ]) ?? Effect.succeed(0);
    for (;;) {
      yield* drainStepBoundary(state, config, "before_llm");
      if (
        publishBudgetTelemetry(state.budgetState, base, config.events, now, config.budget) === "exceeded"
      ) {
        return yield* new AgentStopError({ reason: "budget" });
      }
      const result = yield* runModelStep(state, config, execution, sink, trace, base, compaction, durableExecutor, llm, source, entropy);
      if (result !== undefined) return finish(result);
    }
  }).pipe(Effect.provide(runContext), Effect.onError((cause) => Effect.sync(() => {
    const error = Cause.squash(cause);
    const facts = failureFacts(error);
    const interrupted = Cause.hasInterrupts(cause) || error instanceof Interrupted ||
      (error instanceof LlmRunFailure && error.aborted);
    emitRunFailed(config.events, base, error instanceof Error ? renderBodyCause(error) : thrownAsError(error).message, {
      reason: interrupted ? "aborted" : facts?.reason ?? "unclassified",
      attempt: facts?.attempt ?? state.attempt,
      maxAttempts: facts?.maxAttempts ?? LlmRetry.MAX_ATTEMPTS,
    }, now);
  })), (effect) => compaction === undefined ? effect : Effect.ensuring(effect, compaction.settleAbort()));

  function finish(result: AgentResult): AgentResult {
    emitRunCompleted(config.events, state, base, result.finishReason, now);
    return result;
  }
  }));
  });
}

function runModelStep(
  state: RunState,
  config: ObservedChatAgentConfig,
  execution: NonNullable<ObservedChatAgentConfig["execution"]>,
  sink: Sink | undefined,
  trace: RunTrace,
  base: AgentRunBase,
  compaction: CompactionSessionPort | undefined,
  durableExecutor: Executor,
  llm: Context.Service.Shape<typeof Llm>,
  source: MessageSource,
  entropy: Context.Service.Shape<typeof Entropy>,
): Effect.Effect<AgentResult | undefined, ExecutionError, Scope.Scope | Entropy> {
  return Effect.gen(function* () {
  const executor = durableExecutor;
  let turn: TurnArtifacts | undefined;
  const priorFailures = [...state.modelFailureReasons];
  let provider = config.model.provider;
  const prepareAttempt = (attempt: number, failures: readonly string[]) => Effect.gen(function* () {
    recordRunAttempt(state, attempt);
    const chain = [config.model, ...(config.modelFallbacks ?? [])].slice(state.modelChainStart);
    const selected = selectModel(chain, [...priorFailures, ...failures]);
    const model = yield* llm.resolveModel({ ...selected.model, now: source.now }).pipe(Effect.mapError(modelFailure));
    const modelKey = `${model.providerID}/${model.id}`;
    if (state.modelKey !== undefined && state.modelKey !== modelKey) resetModelWindowGuards(state);
    state.modelKey = modelKey;
    provider = model.providerID;
    recordRunWindow(state, model.limit?.context ?? 0);
    const estimate = config.compactionSeam?.estimate;
    if (
      estimate !== undefined &&
      state.contextWindowTokens !== undefined &&
      estimate(state.messages) > state.contextWindowTokens
    ) {
      yield* applyCompaction(state, config, base, compaction, "yield");
    }
    emitTurnStart(config.events, state, base, source.now);
    const built = buildTurn(state, config, model, config.toolChoice, trace, source, sink);
    if (built.type !== "ready") return yield* new AgentFailure({ operation: "agent.turn", cause: "not_ready" });
    turn = built.turn;
    const prepared = turn;
    return {
      fallbackAvailable: selected.index < chain.length - 1,
      request: {
        op: "chat",
        intent: {
          attempt,
          provider: model.providerID,
          model: model.id,
          messageIds: state.messages.map((m) => m.info.id),
        },
        effect: {},
      },
      admit: () => Effect.suspend<void, ExecutionError, never>(() => {
        if (config.signal?.aborted) return Effect.fail(new Interrupted());
        if (
          evaluateBudget(
            { ...state.budgetState, turns: Math.max(0, state.budgetState.turns - 1) },
            source.now,
            config.budget,
          ).status === "exceeded"
        )
          return Effect.fail(new AgentStopError({ reason: "budget" }));
        if (
          estimate !== undefined &&
          state.contextWindowTokens !== undefined &&
          estimate(state.messages) > state.contextWindowTokens
        ) {
          return Effect.fail(new ContextAdmissionError());
        }
        return Effect.void;
      }),
      body: () => Effect.suspend(() => llm.run(prepared.runInput, prepared.trackingSink)).pipe(
        Effect.mapError(modelFailure),
        Effect.flatMap((result) => {
          if (result.type === "aborted") return Effect.fail(result.error ?? new Interrupted());
          if (result.type === "error") return Effect.fail(result.error);
          return Effect.succeed({
            type: successfulOutcome({ type: result.type }),
            evidence: PlainValueSchema.parse(
              result.type === "stop" ? (result.evidence ?? null) : null,
            ),
          });
        }),
      ),
    };
  }).pipe(Effect.provideService(Entropy, entropy));
  const initial = yield* prepareAttempt(1, []);
  const outcome = yield* executor.run(
    {
      kind: "llm",
      op: "chat",
      intent: initial.request.intent,
      effect: {},
    },
    (parent: import("@openomni/protocol").LedgerAction.Receipt) =>
      execution.runAttempts(parent, {
        prepare: (attempt, failures) =>
          attempt === 1 ? Effect.succeed(initial) : prepareAttempt(attempt, failures),
        evidence: (result) => result.evidence,
        recoverOverflow: () => Effect.gen(function* () {
          if (state.overflowCompactionAttempted) return false;
          state.overflowCompactionAttempted = true;
          return (yield* applyCompaction(state, config, base, compaction, "yield")) === "compacted";
        }).pipe(Effect.provideService(Entropy, entropy)),
        onRetry: (decision) => {
          state.modelFailureReasons.push(decision.reason);
          emitErrorRetry(config.events, base, {
            attempt: decision.attempt,
            maxAttempts: decision.maxAttempts,
            error: decision.error.message,
            reason: LlmRetry.attemptReason(decision.error),
            backoffMs: decision.delayMs,
          }, source.now);
          if (decision.reason !== "context_overflow" && decision.decision.retry)
            observeRetry(config.events, {
              ...base,
              now: source.now,
              provider,
              attempt: decision.attempt,
              maxAttempts: decision.maxAttempts,
              decision: decision.decision,
            });
        },
      }),
  );
  if (outcome.terminal === "interrupted") return yield* new Interrupted();
  if (outcome.terminal !== "executed")
    return yield* new AgentFailure({ operation: "agent.llm", cause: `execution_${outcome.terminal}` });
  if (turn === undefined) return yield* new AgentFailure({ operation: "agent.llm", cause: "missing_turn" });
  const type = successfulOutcome(outcome.value);
  if (type === "continue") {
    handleContinue(config.events, state, base, turn.turnUsage, source.now);
    yield* prepareCompactionAfterContinue(state, config, compaction);
    return undefined;
  }
  const result = yield* handleStop(state, config, execution, base, turn, compaction);
  return result === "continue" ? undefined : result;
  });
}

function modelFailure(error: LlmError): ExecutionError {
  return error instanceof LlmRunFailure ? error : new AgentFailure({
    operation: "llm", cause: error.message,
  });
}

/** Only successful machine outcomes can cross the executor's encoded result boundary. */
function successfulOutcome(value: PlainValue): "stop" | "continue" {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value.type === "stop" || value.type === "continue")
  )
    return value.type;
  throw new AgentInvariantViolation("invalid llm execution result");
}

function createCompactionSession(config: ChatAgentConfig): CompactionSessionPort | undefined {
  const options = config.compaction;
  const seam = config.compactionSeam;
  if (seam === undefined || options?.onSummarize === undefined || options.speculate === false)
    return undefined;
  return seam.createSession({
    protectRecentMessages: options.protectRecentMessages ?? seam.protectRecent,
    summarize: options.onSummarize,
    summarizerDeadlineMs: options.summarizerDeadlineMs,
  });
}
