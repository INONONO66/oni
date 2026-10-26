import { type BusEvent, Message, PlainValueSchema, type PlainValue } from "@oni/protocol";
import { Effect, Clock, Scope, Cause, Context } from "effect";
import type { StopVerdict } from "./stop";
import { type LlmSink as Sink, type LlmFailure, Llm, type LlmPort, isLlmRunFailure, LlmRunFailure, type AttemptEvidence, type ResolvedModel, type RunResult } from "../ports/llm";
import { selectModel } from "./model-select";
import { resolveAgentBudget, publishBudgetTelemetry, evaluateBudget } from "./budget";
import { AgentStopError, AgentInvariantViolation, AgentFailure, type ExecutionError, Interrupted, ContextAdmissionError, renderBodyCause, thrownAsError } from "../ports/failure";
import type { AgentResult, ChatAgentInput, TokenUsage, ChatAgentConfig, ObservedChatAgentConfig } from "../ports/types";
import { createUserMessage, withMessageId, type MessageSource } from "../journal/message-factory";
import type { CompactionPort, CompactionReason } from "../ports/compaction-ports";
import { failureFacts, MAX_ATTEMPTS, observeRetry } from "./retry";
import { settleModelTools, assertToolExecutor, assertUnambiguousToolMetadata } from "./tool";
import { Entropy, ObservationSink } from "../ports/ports";
import { ExecutorContext, type Executor } from "./executor";
import { advanceRunTurn, appendRunMessages, appendRunStep, assistantTextOf, buildTurn, createRunState, disarmWindowYield, nonEmptyString, recordBilledUsage, recordRunAttempt, recordRunWindow, requireTrace, resetModelWindowGuards, runResult, type RunState, type RunTrace, type TurnArtifacts } from "./state";
import { emitErrorRetry, emitRunCompleted, emitRunFailed, emitRunStarted, emitTurnComplete, emitTurnStart, type AgentRunBase } from "./../observation/turn-events";

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

type StopOutcome = AgentResult | "continue";

/**
 * A turn whose last step still asked for tools was stopped by the loop (step cap or window yield);
 * anything else is the model's own stop.
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
  // The cap outranks steering ("max-steps" stays the honest terminal even if the
  // steering check also fired); steering outranks the window (the pending message
  // should reach the model next turn; a still-full window re-arms and yields again).
  if (turn.steering.requested) return "steer";
  return turn.windowYieldArmed ? "window" : "steps";
}

function handleStop(
  state: RunState,
  config: ObservedChatAgentConfig,
  execution: NonNullable<ObservedChatAgentConfig["execution"]>,
  agentBase: AgentRunBase,
  turn: TurnArtifacts,
  compact: Compact,
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

  const yielded = toolCalls > 0 ? null : turnYield(turn, assistantMessage);
  const compacted = yield* compact(yielded === "window" ? "yield" : "threshold");
  if (yielded === "window" && (!compacted || state.lastCompactionIneffective))
    disarmWindowYield(state);
  const evidence = yield* config.stopEvidence();
  const judgment = yield* execution.judgeStop(state.stop, {
    ...evidence,
    text: turnText,
    toolCalls,
    calls: assistantMessage.parts.flatMap((part) =>
      part.type === "tool" ? [{ tool: part.tool, input: part.state.input }] : []),
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
      withMessageId(createUserMessage(message.content ?? [{ kind: "text", text: message.text }], state.sessionId, { now: () => created, id }), message.id),
    ]);
  }
  return drained?.messages.length ?? 0;
  });
}

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
    // Resolve the run budget once at entry: the explicit budget wins per field.
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
  emitRunStarted(config.events, trace, config.model.id, now);
  const needsExecutorContext = (config.tools?.length ?? 0) > 0 ||
    config.toolExecutor !== undefined || config.toolWave !== undefined;
  const runContext = needsExecutorContext
    ? Context.make(ExecutorContext, durableExecutor).pipe(Context.add(Scope.Scope, scope))
    : Context.make(Scope.Scope, scope);
  return Effect.gen(function* () {
    const compaction = yield* bindCompaction(config, base, durableExecutor);
    const compact = compactWith(state, compaction, scope, entropy);
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
      const result = yield* runModelStep(state, config, execution, sink, trace, base, compaction, compact, durableExecutor, llm, source, entropy);
      if (result !== undefined) return finish(result);
    }
  }).pipe(Effect.provide(runContext), Effect.onError((cause) => Effect.sync(() => {
    const error = Cause.squash(cause);
    const facts = failureFacts(error);
    const interrupted = Cause.hasInterrupts(cause) || error instanceof Interrupted ||
      (isLlmRunFailure(error) && error.aborted);
    emitRunFailed(config.events, base, error instanceof Error ? renderBodyCause(error) : thrownAsError(error).message, {
      reason: interrupted ? "aborted" : facts?.reason ?? "unclassified",
      attempt: facts?.attempt ?? state.attempt,
      maxAttempts: facts?.maxAttempts ?? MAX_ATTEMPTS,
    }, now);
  })));

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
  compaction: CompactionPort | undefined,
  compact: Compact,
  durableExecutor: Executor,
  llm: LlmPort,
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
    const model = yield* llm.resolveModel(selected.model, source.now).pipe(Effect.mapError(modelFailure));
    const modelKey = `${model.providerID}/${model.id}`;
    if (state.modelKey !== undefined && state.modelKey !== modelKey) resetModelWindowGuards(state);
    state.modelKey = modelKey;
    provider = model.providerID;
    recordRunWindow(state, model.limit?.context ?? 0);
    if (overflowsWindow(state, compaction)) yield* compact("yield");
    emitTurnStart(config.events, state, base, source.now);
    const built = buildTurn(state, config, model, config.toolChoice, trace, source, sink, compaction);
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
        if (overflowsWindow(state, compaction)) return Effect.fail(new ContextAdmissionError());
        return Effect.void;
      }),
      body: () => Effect.suspend(() => llm.run(prepared.runInput, prepared.trackingSink)).pipe(
        Effect.tap((result) => Effect.sync(() => recordBilledUsage(state, prepared, result.billedUsage))),
        Effect.mapError(modelFailure),
        Effect.flatMap((result) => settleAttempt(llm, model, result)),
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
    (parent: import("@oni/protocol").LedgerAction.Receipt) =>
      execution.runAttempts(parent, {
        prepare: (attempt, failures) =>
          attempt === 1 ? Effect.succeed(initial) : prepareAttempt(attempt, failures),
        evidence: (result) => result.evidence,
        recoverOverflow: () => Effect.gen(function* () {
          if (state.overflowCompactionAttempted) return false;
          state.overflowCompactionAttempted = true;
          return yield* compact("overflow");
        }).pipe(Effect.provideService(Entropy, entropy)),
        classify: (failure) => llm.classifyFailure({
          error: failure,
          now: source.now(),
          ...(isLlmRunFailure(failure) ? { usage: failure.usage } : {}),
          ...(state.contextWindowTokens === undefined ? {} : { contextWindow: state.contextWindowTokens }),
        }),
        onRetry: (decision) => {
          state.modelFailureReasons.push(decision.reason);
          emitErrorRetry(config.events, base, {
            attempt: decision.attempt,
            maxAttempts: decision.maxAttempts,
            error: decision.error.message,
            reason: decision.reason,
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
    yield* compact("prepare");
    return undefined;
  }
  const result = yield* handleStop(state, config, execution, base, turn, compact);
  return result === "continue" ? undefined : result;
  });
}

/** One attempt's result as the executor sees it; a stop whose usage proves the window was exceeded is an overflow the provider did not name and enters the same recovery path. */
function settleAttempt(
  llm: LlmPort,
  model: ResolvedModel,
  result: RunResult,
): Effect.Effect<{ readonly type: "stop" | "continue"; readonly evidence: PlainValue }, ExecutionError> {
  if (result.type === "aborted") return Effect.fail(result.error ?? new Interrupted());
  if (result.type === "error") return Effect.fail(result.error);
  if (result.type === "stop" && result.evidence !== undefined && stopOverflows(llm, model, result.evidence))
    return Effect.fail(overflowStop(model, result.evidence));
  return Effect.succeed({
    type: successfulOutcome({ type: result.type }),
    evidence: PlainValueSchema.parse(result.type === "stop" ? (result.evidence ?? null) : null),
  });
}

function modelFailure(error: LlmFailure): ExecutionError {
  return isLlmRunFailure(error) ? error : new AgentFailure({
    operation: "llm", cause: error.message,
  });
}

/** The port's overflow verdict over a stop that showed nothing; a visible stop is the answer and is never replayed. */
function stopOverflows(llm: LlmPort, model: ResolvedModel, evidence: AttemptEvidence): boolean {
  const contextWindow = model.limit?.context;
  if (evidence.visibleOutput || contextWindow === undefined || contextWindow <= 0) return false;
  return llm.classifyFailure({ usage: evidence.usage, finishReason: evidence.finishReason, contextWindow }).kind === "overflow";
}

/** The declared overflow the attempt loop recovers from, built from the stop's own evidence. */
function overflowStop(model: ResolvedModel, evidence: AttemptEvidence): LlmRunFailure {
  return new LlmRunFailure({
    message: `context window exceeded: ${evidence.usage.inputTokens + evidence.usage.cacheReadTokens} input tokens against ${model.limit?.context ?? 0}`,
    provider: model.providerID,
    model: model.id,
    usage: evidence.usage,
    usageProvenance: evidence.usageProvenance,
    aborted: false,
    contextOverflow: true,
    visibleOutput: evidence.visibleOutput,
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

/** True when a rewrite happened; a typed failure from the plugin fails the step like any execution error. */
type Compact = (reason: CompactionReason) => Effect.Effect<boolean, ExecutionError>;

function bindCompaction(
  config: ObservedChatAgentConfig,
  identity: AgentRunBase,
  executor: Executor,
): Effect.Effect<CompactionPort | undefined, never, Scope.Scope> {
  const compaction = config.compactionPort;
  if (compaction === undefined) return Effect.succeed(undefined);
  return compaction.bind({ options: config.compaction, identity, events: config.events, executor, signal: config.signal });
}

/** The one place the loop asks the plugin to compact; with no port bound nothing happens. */
function compactWith(
  state: RunState,
  compaction: CompactionPort | undefined,
  scope: Scope.Scope,
  entropy: Context.Service.Shape<typeof Entropy>,
): Compact {
  return (reason) => Effect.gen(function* () {
    if (compaction === undefined) return false;
    const before = state.compactionCount;
    const outcome = yield* compaction.maybeCompact(state, reason);
    if (typeof outcome === "object") return yield* Effect.fail(outcome.failed);
    return state.compactionCount > before;
  }).pipe(Effect.provideService(Entropy, entropy), Effect.provideService(Scope.Scope, scope));
}

function overflowsWindow(state: RunState, compaction: CompactionPort | undefined): boolean {
  const window = compaction?.window(state);
  return window !== undefined && state.contextWindowTokens !== undefined &&
    window.measure(state.messages) > state.contextWindowTokens;
}

export { stopState } from "./stop";
export type { StopObservation, StopVerdict } from "./stop";
export { RunEvents } from "../observation/run-events";
export { type RunTrace, type RunState, type TurnArtifacts, createRunState, recordRunTurn, recordCallContext, advanceRunTurn, buildTurn } from "./state";
