import type { OpenTurn } from "../store/session-reads";
import { Effect, Exit, type Scope, Cause } from "effect";
import * as Failure from "../ports/failure";
import { type SessionError, type ExecutionError, CommitFailed, AgentFailure } from "../ports/failure";
import { type ExecutionLedger, type ExecutionResult, createExecutor, type Executor } from "../loop/executor";
import type { SessionPolicyRefusal } from "../journal/messages";

import type { SessionKernel } from "./entity";
import { type Delivery, type LedgerSession, type Model, type SessionGeneration, type SessionTurn, canonicalDigest, type TraceContext } from "@openomni/protocol";
import type { ChatAgentConfig, AgentResult } from "../ports/types";
import { ObservationSink as ObservationService, type RunnerServices, GenerationOwnership, interruptOn } from "../ports/ports";
import { commitFoldBatch } from "../journal/compaction";
import { turnCheckpointAction, turnTerminalAction } from "../journal/turn-rows";
import { deliveryActions, boundaryConsumption, consumptionSettings } from "../journal/delivery";
import { policyRefusalResult, sessionRunnerResultValue, sessionRunnerResultFromValue } from "../journal/commit";
import { hydrateSessionHistory, refreshSessionHistory } from "../../inspect/history";
import { observeDrained, scopeObservation } from "../observation/bus";
import { runAgent } from "../loop/turn";
import type { ResolvedSessionRuntime, SessionBoundaryResult, SessionControllerState, SessionRunner, SessionRunnerInput, SessionRunnerResult } from "./runtime";
import { InboundAuthorityViolated, promptInboundAuthority, runnerOutputMissingResult, sessionStopEvidence } from "./turn-open";
import { dispatchSessionOutbound, outboundOpen } from "./outbound";

interface TurnInput {
  readonly turnId: string;
  readonly resultId: string;
  readonly parentActionId: string;
  readonly boundaryActionId: string | null;
  readonly resumeCount: number;
  readonly generation: SessionGeneration.Snapshot;
  readonly resume: boolean;
}

export function createSessionTurn(
  kernel: SessionKernel,
  sessionId: string,
  runner: SessionRunner,
  runtime: ResolvedSessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  scope: Scope.Scope,
  ports: {
    readonly createExecutionLedger: (turnId?: string) => ExecutionLedger;
    readonly evaluatePromptPolicies: (items: readonly Delivery.Row[]) => Effect.Effect<{ readonly refusal: SessionPolicyRefusal | undefined; readonly contents: ReadonlyMap<string, string> }, ExecutionError, RunnerServices>;
    readonly consumePolicyBlockedDeliveries: (items: readonly Delivery.Row[]) => Effect.Effect<void, ExecutionError>;
    readonly hibernate: (current: LedgerSession.Row) => Effect.Effect<void, SessionError>;
  },
) {
  function runTurn(input: TurnInput): Effect.Effect<SessionRunnerResult, SessionError> {
    return Effect.scoped(Effect.gen(function* () {
      const captured = yield* runtime.generations.capture({ sessionId, generation: input.generation.generation });
      const ownership = { ...captured, retain() {
        const generation = captured.retain();
        const session = state.rawSlots.open();
        return () => { generation(); session(); };
      } };
      return yield* captured.provide(runCaptured(input).pipe(Effect.provideService(GenerationOwnership, ownership))).pipe(Effect.provide(runtime.services));
    }));
  }

  function runCaptured(input: TurnInput): Effect.Effect<SessionRunnerResult, SessionError, RunnerServices> {
    return Effect.gen(function* () {
      const services = yield* Effect.context<RunnerServices>();
      const row = kernel.row(sessionId);
      const controller = new AbortController();
      state.controller = controller;
      let parentActionId = input.parentActionId;
      let boundaryActionId = input.boundaryActionId;
      const ledger = ports.createExecutionLedger(input.turnId);
      const retainEffect = (raw: Promise<void>) => {
        const settle = state.rawSlots.open();
        void raw.then(settle);
      };
      const execution = yield* createExecutor({
        retryAlarm: runtime.retryAlarm, signal: controller.signal, retainEffect,
        closeGraceMs: runtime.closeGraceMs, ledger, approvalPolicy: runtime.approvalPolicy,
        identity: { sessionId, role: row.role, parentActionId: input.turnId },
      });
      const boundary = (kind: SessionTurn.Boundary): Effect.Effect<SessionBoundaryResult, ExecutionError> => Effect.gen(function* () {
        if (controller.signal.aborted) return { messages: [], interrupted: true };
        const drained = yield* drainBoundary(input, kind, parentActionId, boundaryActionId);
        parentActionId = drained.parentActionId;
        boundaryActionId = drained.boundaryActionId;
        if (drained.interrupted) controller.abort();
        return { messages: drained.messages, interrupted: drained.interrupted };
      }).pipe(Effect.provide(services));
      let runnerResult: SessionRunnerResult = runnerOutputMissingResult(input.turnId);
      const body = Effect.gen(function* () {
        if (controller.signal.aborted) return yield* Effect.interrupt;
        const hydrated = hydrateSessionHistory(kernel, sessionId);
        const promptId = hydrated.messages.filter((message) => message.role === "user").at(-1)?.id;
        // The prompt's origin is its action row's intent — a point read, not a whole-chain fold.
        const origin = promptId === undefined ? undefined : kernel.actionById(promptId)?.intent;
        const inbound = promptInboundAuthority(promptId, origin?.value);
        if (inbound.violation !== undefined) {
          const observations = yield* ObservationService;
          scopeObservation(observations, { sessionId, turnId: input.turnId }, { now: clock, id: entropy }).publish(
            InboundAuthorityViolated,
            { reason: inbound.violation.reason, ...(promptId === undefined ? {} : { messageId: promptId }) },
          );
        }
        // A prompt with no recorded origin fails the turn typed — the runner never runs.
        if (inbound.violation?.reason === "missing_origin") {
          runnerResult = { kind: "error", text: inbound.violation.message, cause: inbound.violation };
          return sessionRunnerResultValue(runnerResult);
        }
        runnerResult = yield* runner({
          authority: inbound.authority,
          sessionId, kernel, role: row.role, turnId: input.turnId, actionId: input.parentActionId,
          ledger, retainEffect, bindApprovals: (approvals) => { state.activeApprovals = approvals; },
          stopEvidence: sessionStopEvidence(kernel, sessionId, input.turnId, () => state.activeApprovals, runtime.openIntent),
          resultId: input.resultId, parentActionId, boundaryActionId,
          messages: hydrated.messages,
          history: hydrated.history,
          tools: input.generation.tools, toolsGeneration: input.generation.generation, toolsHash: input.generation.toolsHash,
          system: input.generation.systemValue, systemHash: input.generation.systemHash, policyGeneration: input.generation.policyGeneration,
          resumeCount: input.resumeCount, signal: controller.signal, boundary,
        });
        return sessionRunnerResultValue(runnerResult);
      });
      const work = execution.runExisting({
        kind: "turn", op: "session",
        intent: {
          turnId: input.turnId, resultId: input.resultId, resumeCount: input.resumeCount, resume: input.resume,
          toolsGeneration: input.generation.generation, toolsHash: input.generation.toolsHash,
          systemHash: input.generation.systemHash, policyGeneration: input.generation.policyGeneration,
        }, effect: { terminal: "sealed" },
      }, () => withSignal(body, controller.signal));
      const exit = yield* Effect.exit(work);
      const result = resultOf(exit, runnerResult);
      if (state.controller === controller) state.controller = undefined;
      // A raw slot, unlike its fiber, can outlive interruption. Its generation
      // remains owned by the app Scope until actual raw settlement.
      const retained = state.rawSlots.pending() > 0;
      if (!state.terminalFrozen) {
        const latestAction = kernel.latestAction(sessionId);
        if (latestAction === undefined) return yield* Effect.die(new Error(`session tree is empty: ${sessionId}`));
        yield* seal({
          turnId: input.turnId, resultId: input.resultId, resumeCount: input.resumeCount, boundaryActionId,
          toolsGeneration: input.generation.generation, toolsHash: input.generation.toolsHash,
          systemHash: input.generation.systemHash, policyGeneration: input.generation.policyGeneration, action: latestAction,
        }, result);
      }
      if (retained) {
        state.retainedRunner = yield* Effect.forkIn(state.rawSlots.awaitSettled.pipe(
          Effect.onExit(() => Effect.gen(function* () {
            state.retainedRunner = undefined;
            yield* ports.hibernate(kernel.row(sessionId)).pipe(Effect.orDie);
          })),
        ), scope);
      }
      return result;
    });
  }

  function drainBoundary(input: TurnInput, boundary: SessionTurn.Boundary, parentActionId: string, boundaryActionId: string | null) {
    return Effect.gen(function* () {
      const observations = yield* ObservationService;
      // Steer rows drain at tool.post boundaries, followUp rows at turn end. EVERY boundary
      // closes a late `action` with `after` behind the compaction head durably, never delivers it.
      const { consumed: pending, stale } = boundaryConsumption(
        kernel.pendingMessages(sessionId),
        boundary,
        consumptionSettings(kernel, sessionId),
        kernel.compactionHead(sessionId),
      );
      if (pending.length === 0 && stale.length === 0)
        return { messages: [], interrupted: false, parentActionId, boundaryActionId };
      const evaluated = yield* ports.evaluatePromptPolicies(pending);
      if (evaluated.refusal !== undefined) {
        yield* ports.consumePolicyBlockedDeliveries(pending);
        return yield* new AgentFailure({ operation: "session.prompt", cause: evaluated.refusal.reason });
      }
      // Deliver the rewritten body, not the original.
      const delivered = pending.map((item) => {
        const body = evaluated.contents.get(item.id);
        return body === undefined ? item : { ...item, content: body };
      });
      const checkpointId = entropy();
      const deliveries = deliveryActions(
        delivered,
        { kind: "turn", turnId: input.turnId },
        boundary,
        checkpointId,
      );
      const checkpoint = turnCheckpointAction({
        id: checkpointId, parentId: parentActionId, sessionId, turnId: input.turnId, resultId: input.resultId,
        resumeCount: input.resumeCount, boundaryActionId: checkpointId, boundary,
        deliveryIds: pending.map((item) => item.id), consumedStale: stale.map((item) => item.id), at: clock(),
      });
      const current = kernel.row(sessionId);
      yield* commitFoldBatch(kernel, {
        sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
        actions: [checkpoint, ...deliveries],
        state: current.state === "interrupted" ? "interrupted" : "running",
      }, runtime.compaction).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      observeDrained(delivered, input.turnId, boundary, clock(), observations, entropy);
      return {
        messages: delivered.filter((item) => item.kind === "prompt").map((item) => ({ id: item.id, role: "user" as const, text: item.content })),
        interrupted: delivered.some((item) => item.kind === "interrupt" || item.kind === "cancel"),
        parentActionId: deliveries.at(-1)?.id ?? checkpointId, boundaryActionId: checkpointId,
      };
    });
  }

  function seal(open: OpenTurn, result: SessionRunnerResult): Effect.Effect<void, SessionError> {
    return Effect.gen(function* () {
      const current = kernel.row(sessionId);
      const latest = kernel.latestAction(sessionId);
      const interrupts = result.kind === "interrupted" ? kernel.pendingMessages(sessionId).filter((item) => item.kind === "interrupt" || item.kind === "cancel") : [];
      const deliveries = deliveryActions(
        interrupts,
        { kind: "turn", turnId: open.turnId },
        "before_llm",
        latest?.id ?? open.action.id,
      );
      const terminal = turnTerminalAction({
        id: open.resultId, parentId: deliveries.at(-1)?.id ?? latest?.id ?? open.action.id,
        sessionId, turnId: open.turnId, result, resumeCount: open.resumeCount, boundaryActionId: open.boundaryActionId, at: clock(),
      });
      // A child settles toward its parent exactly once: an existing settlement row skips the fold.
      const settled =
        current.parentId !== null &&
        kernel
          .outboundRows(sessionId)
          .some((item) => item.message.destinationSessionId === current.parentId);
      const reply = settled
        ? undefined
        : runtime.settleChild?.(kernel, current, terminal, result);
      yield* commitFoldBatch(kernel, {
        sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
        actions: [...deliveries, terminal, ...(reply === undefined ? [] : [outboundOpen(reply, terminal.ts)])],
        state: result.kind === "interrupted" ? "interrupted" : "idle",
      }, runtime.compaction).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      observeDrained(interrupts, open.turnId, "before_llm", clock(), runtime.observations, runtime.entropy);
      if (reply !== undefined) yield* dispatchSessionOutbound(kernel, sessionId, runtime, owner, state.fence, clock);
    });
  }
  return { runTurn, seal };
}

function withSignal<A, E, R>(work: Effect.Effect<A, E, R>, signal: AbortSignal) {
  return work.pipe(Effect.raceFirst(interruptOn(signal)));
}

function resultOf(exit: Exit.Exit<ExecutionResult, ExecutionError>, value: SessionRunnerResult): SessionRunnerResult {
  if (Exit.isFailure(exit)) {
    if (Cause.hasInterrupts(exit.cause)) return { kind: "interrupted", text: "" };
    const cause = Failure.of(exit.cause, "session.turn");
    return { kind: "error", text: cause.message, cause };
  }
  const outcome = exit.value;
  if (outcome.terminal !== "executed") return policyRefusalResult(outcome.reason);
  if (canonicalDigest(outcome.value) === canonicalDigest(sessionRunnerResultValue(value))) return value;
  return sessionRunnerResultFromValue(outcome.value) ?? policyRefusalResult("invalid_output");
}

interface SessionChatRun {
  readonly config: Omit<ChatAgentConfig, "stopEvidence"> & { readonly executor: Executor };
  readonly traceContext: TraceContext.Type;
  readonly around?: (operation: Effect.Effect<AgentResult, ExecutionError, RunnerServices>) => Effect.Effect<AgentResult, ExecutionError, RunnerServices>;
}

interface SessionChatRunnerOptions {
  readonly prepare: (input: SessionRunnerInput) => Effect.Effect<SessionChatRun, ExecutionError, RunnerServices>;
  readonly reportError?: (error: Error, input: SessionRunnerInput) => string | undefined;
  /** App-injected pinned-model read; absent = no turn-start pin, start at the primary. */
  readonly pinnedModel?: (kernel: SessionKernel, sessionId: string, turnId: string) => Model.Ref | undefined;
}

export function createSessionChatRunner(options: SessionChatRunnerOptions): SessionRunner {
  return (input) => Effect.gen(function* () {
    const messages = input.messages.map((message) => ({ role: message.role, content: message.text, id: message.id }));
    const prepared = yield* options.prepare(input);
    const executor = prepared.config.executor;
    if (executor.recover === undefined || executor.runAttempts === undefined || executor.judgeStop === undefined)
      return yield* Effect.die(new Error("durable chat runner requires session authority"));
    const captured = hydrateSessionHistory(input.kernel, input.sessionId);
    yield* executor.recover();
    const refreshed = refreshSessionHistory(input.kernel, input.sessionId, captured);
    const operation = runAgent({
      messages,
      history: refreshed.history,
      // A resumed turn keeps its charged work.
      budgetState: refreshed.state.budgetState,
      traceContext: prepared.traceContext,
    }, {
      ...prepared.config,
      pinnedModel: options.pinnedModel?.(input.kernel, input.sessionId, input.turnId),
      execution: { runAttempts: executor.runAttempts, judgeStop: executor.judgeStop },
      signal: input.signal,
      boundary: input.boundary,
      stopEvidence: input.stopEvidence,
    });
    const result = yield* (prepared.around?.(operation) ?? operation);
    if (result.waiting !== undefined) return { kind: "waiting", text: result.text, ...result.waiting } satisfies SessionRunnerResult;
    return { kind: "result", text: result.text, finishReason: result.finishReason, usage: result.usage } satisfies SessionRunnerResult;
  }).pipe(Effect.catch((error): Effect.Effect<SessionRunnerResult, ExecutionError> => {
    if (error._tag === "Interrupted" || (error._tag === "LlmRunFailure" && error.aborted))
      return Effect.succeed({ kind: "interrupted" } satisfies SessionRunnerResult);
    const reported = options.reportError?.(error, input);
    return reported === undefined ? Effect.fail(error) : Effect.succeed({
      kind: "error", text: reported, cause: error, reported: true,
    } satisfies SessionRunnerResult);
  }));
}

export { SessionPolicyRefusal } from "../journal/messages";
export { GenerationRawSlots } from "../loop/executor";
export { type SessionTool, type SessionSystem, type SessionCreateOptions, type SessionRunnerInput, type SessionBoundaryResult, type SessionRunnerResult, type SessionRunner, type SessionRuntime, type ComposedManifest, composedManifest, type ResolvedSessionRuntime, resolveSessionRuntime, type SessionHandle, type SessionController, type RegistryEntry, type SessionControllerLifecycle, type SessionAdmissionSnapshot, type SessionEntityAuthority, type SessionEntityTurnInput, type SessionEntityPorts, type SessionControllerState, adoptedExecutor, adoptSessionAuthority, installSessionHandlePlane, getSessionHandle, closeSessions } from "./runtime";
export { createSessionConfiguration, type GenerationBundle, makeSessionGenerations } from "./generations";
export { dispatchSessionOutbound } from "./outbound";
export { sessionStopEvidence, InboundAuthorityViolated, inboundAuthority, promptInboundAuthority, runnerOutputMissingResult } from "./turn-open";
