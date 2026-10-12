import type { LedgerError } from "../store/errors";
import { Effect, Scope, Context, Deferred, Exit, Cause, Option, Clock, Fiber } from "effect";
import * as Failure from "../failure";
import { renderBodyCause } from "../failure";
import { thrownAsError } from "../store/storage/sqlite-l0-observation";
import { type ExecutionError, GenerationUnavailable, InvocationClosed, CommitFailed, ExecutionApprovalError, PolicyDenied, AgentFailure, Interrupted, OutcomeUnknown } from "../failure";
import { type BusEvent, GateDecision, LedgerAction, type LedgerSession, type ObservationSink as ObservationPort, type PlainValue, type SessionTransition, Tool, type PlainObject, L0Observation, canonicalDigest, PlainValueSchema, RowVerdictType, SessionHistory, listenForAbort } from "@openomni/protocol";
import type { CompiledPolicySnapshot, PolicyEvaluationInput, PolicyEvaluation } from "./compile";
import type { RetryAlarmPort, RetryAlarmDeps } from "../alarm-ports";
import { createRetryAlarmPort } from "../alarm";
import { turnStopAction } from "../commit";
import { DEFAULT_TOOL_OUTPUT_BUDGET_BYTES, projectResultValue } from "../tool-output";
import type { WaveControl, Dispatcher } from "../tool";
import { AsyncLocalStorage } from "node:async_hooks";
import { onAbort, type CapturedGeneration, BOUNDED_CONCURRENCY, Entropy, ObservationSink, SessionLayer, type ProcessServices } from "../ports";
import { createApprovalRequest } from "../request-binding";
import type { ApprovalPolicy } from "../approval-policy";
import { Retry } from "../../model";
import { attachFailureFacts } from "../retry";
import { judgeStop, type StopState, type StopObservation, type StopMetric } from "../stop";
import type * as SessionHandleStore from "../store/fence";
import { executionPoint } from "../points";

// ─── from executor-contract.ts (#1247) ───
interface ExecutionKindRegistration {
  readonly kind: string;
  readonly effect: PlainValue;
  readonly reversible: boolean;
  readonly inputSchema: PlainValue;
}

export interface ExecutionLedger {
  commit(action: LedgerAction.Append): Effect.Effect<LedgerAction.Receipt, LedgerError>;
  /** #1305: resolved per-generation tool output budget; absent falls back to the core default. */
  toolOutputBudgetBytes?(): number;
  /** #1305: content-addressed tool output store write (idempotent on the digest key). */
  putToolOutput?(write: { readonly outputId: string; readonly bytes: Uint8Array; readonly mediaType?: string }): void;
  /** #1305: read one stored output back by its identifier. */
  toolOutput?(outputId: string): { readonly outputId: string; readonly bytes: Uint8Array; readonly mediaType?: string } | undefined;
  actionById?(id: string): LedgerAction.Node | undefined;
  requestById?(id: string): SessionTransition.Request | undefined;
  resultFor?(id: string): LedgerAction.Node | undefined;
  openOperationsPage?(turnId: string, cursor: number): readonly LedgerAction.Node[];
  operationChildrenPage?(parentId: string, cursor: number): readonly LedgerAction.Node[];
  guardedOperationsPage?(turnId: string, cursor: number): readonly LedgerAction.Node[];
  validateRequest?(request: SessionTransition.Request): boolean;
  transition?(
    payload: SessionTransition.Payload,
    inputId: string,
    at: number,
  ): Effect.Effect<import("../request").RequestDecision, ExecutionError>;
}

interface ExecutionIdentity {
  readonly sessionId: string;
  readonly role: LedgerSession.Role;
  readonly parentActionId: string | null;
  readonly turnId?: string;
  readonly toolsHash?: string;
  readonly toolsGeneration?: number;
  readonly systemHash?: string;
}

interface ToolObservationIdentity {
  readonly turnId: string;
  readonly callId: string;
  readonly timeoutMs?: number;
}

/** How an interrupted effect may be settled from evidence; nothing here permits a replay. */
type RecoveryClassification =
  | "local_transactional"
  | "endpoint_idempotent"
  | "read_back_reconcilable"
  | "ambiguous_no_replay";

export interface ExecutionRequest {
  readonly kind: string;
  readonly op: string;
  readonly intent: PlainValue;
  readonly effect: PlainValue;
  /** Recorded on the intent so crash-open recovery classifies from durable evidence. */
  readonly recovery?: RecoveryClassification;
  readonly message?: PolicyEvaluationInput["message"];
  readonly revert?: () => Effect.Effect<void, ExecutionError>;
  /** Result-dependent evidence for a reversible durable projection. */
  readonly revertData?: () => PlainValue | undefined;
  /**
   * Commit the settled value as a durable boundary child action (one ledger
   * transaction) before the result commit and any publication: a crash after
   * the boundary recovers the executed value without re-running the body.
   */
  readonly boundary?: boolean;
  readonly toolObservation?: ToolObservationIdentity;
  /** Model-facing settlement, committed atomically with the tool's effect evidence. */
  readonly toolResult?: (outcome: ExecutionBatchResult) => Tool.Result;
  readonly approval?: {
    readonly required: boolean;
    readonly domainRevisions: Readonly<Record<string, number>>;
    readonly timeoutMs?: number;
  };
  readonly domainRevisions?: () => Readonly<Record<string, number>>;
  readonly originalAction?: LedgerAction.Node;
}

interface AttemptRequest {
  readonly op: string;
  readonly intent: PlainValue;
  readonly effect: PlainValue;
}

export interface LlmAttempts<T extends PlainValue> {
  prepare(
    attempt: number,
    failureReasons: readonly string[],
  ): Effect.Effect<{
    readonly request: AttemptRequest;
    readonly fallbackAvailable?: boolean;
    admit(): Effect.Effect<void, ExecutionError>;
    body(): Effect.Effect<T, ExecutionError>;
  }, ExecutionError>;
  recoverOverflow?(error: ExecutionError): Effect.Effect<boolean, ExecutionError>;
  /** Durable attempt evidence (usage, visible-output boundary, credential handle) projected from a settled body. */
  evidence?(value: T): PlainValue;
  onRetry?(decision: {
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly delayMs: number;
    readonly decision: import("../../model").Retry.Decision;
    readonly error: Error;
    readonly reason: string;
  }): void;
}

export type ExecutionResult =
  | { readonly terminal: "blocked_pre"; readonly reason: string }
  | { readonly terminal: "executed"; readonly value: PlainValue; readonly failure?: ExecutionError }
  | { readonly terminal: "interrupted"; readonly reason: string }
  | { readonly terminal: "outcome_unknown"; readonly reason: string }
  | {
      readonly terminal: "blocked_post";
      readonly disposition: "reverted" | "irreversible";
      readonly reason: string;
    };

export interface ExecutionApprovalRequest {
  readonly durable: SessionTransition.Request;
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly callId: string;
  readonly inputHash: string;
  readonly expiresAt?: number;
  readonly generation: number;
  readonly revision: number;
  readonly policyDecisionId: string;
  readonly toolsHash?: string;
  readonly toolsGeneration?: number;
  readonly intent: PlainValue;
}

interface ExecutionApprovalAnswer {
  readonly request: ExecutionApprovalRequest;
  readonly decision: "approve" | "refuse";
  readonly credential: string;
}

interface OwnerApprovalEvidence {
  readonly kind: "owner";
  readonly principalId: string;
  readonly evidenceId: string;
}

export interface ExecutionApprovals {
  pending(): readonly ExecutionApprovalRequest[];
  answer(answer: ExecutionApprovalAnswer): Effect.Effect<void, ExecutionError>;
  notify?(request: SessionTransition.Request): void;
}

export interface ExecutionBatchItem<R = never> {
  readonly request: ExecutionRequest;
  readonly sequential?: true;
  body(intent: LedgerAction.Receipt, admittedInput: PlainValue): Effect.Effect<PlainValue, ExecutionError, R>;
}
export type ExecutionBatchResult = ExecutionResult;

export interface Executor {
  recover?(): Effect.Effect<void, ExecutionError>;
  runAttempts?<T extends PlainValue>(
    parent: LedgerAction.Receipt,
    attempts: LlmAttempts<T>,
  ): Effect.Effect<T, ExecutionError>;
  readonly judgeStop?: DurableExecutor["judgeStop"];
  readonly approvals?: ExecutionApprovals;
  runBatch?<R>(
    items: readonly ExecutionBatchItem<R>[],
    control: WaveControl,
  ): Effect.Effect<readonly ExecutionBatchResult[], ExecutionError, Exclude<R, RawToolSlots | Scope.Scope>>;
  run<T extends PlainValue, R>(
    request: ExecutionRequest,
    body: (intent: LedgerAction.Receipt, admittedInput: PlainValue) => Effect.Effect<T, ExecutionError, R>,
  ): Effect.Effect<ExecutionResult, ExecutionError, Exclude<R, RawToolSlots | Scope.Scope>>;
}

export interface DurableExecutor extends Executor {
  recover(): Effect.Effect<void, ExecutionError>;
  runBatch<R>(
    items: readonly ExecutionBatchItem<R>[],
    control: WaveControl,
  ): Effect.Effect<readonly ExecutionBatchResult[], ExecutionError, Exclude<R, RawToolSlots | Scope.Scope>>;
  judgeStop(
    state: import("../stop").StopState,
    observation: import("../stop").StopObservation,
  ): Effect.Effect<{
    state: import("../stop").StopState;
    verdict: import("../stop").StopVerdict;
  }, ExecutionError>;
  runExisting<T extends PlainValue, R>(
    request: ExecutionRequest,
    body: (pre: PolicyEvaluation) => Effect.Effect<T, ExecutionError, R>,
  ): Effect.Effect<ExecutionResult, ExecutionError, R>;
  runAttempts<T extends PlainValue>(
    parent: LedgerAction.Receipt,
    attempts: LlmAttempts<T>,
  ): Effect.Effect<T, ExecutionError>;
}

/**
 * Route-change evidence on a retry attempt (#1276: gate-owned; formerly the
 * model-selection plugin). A route switch is evidence on the newly admitted
 * attempt, not a rewritten selection.
 */
function attemptRouteChange(
  previous: LedgerAction.Receipt | undefined,
  next: PlainValue,
): PlainValue {
  const asRecord = (value: PlainValue | undefined): PlainObject =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (previous === undefined) return null;
  const from = asRecord(asRecord(previous.action.intent.value).value);
  const to = asRecord(next);
  if (typeof from.provider !== "string" || typeof from.model !== "string" ||
      typeof to.provider !== "string" || typeof to.model !== "string") return null;
  if (from.provider === to.provider && from.model === to.model) return null;
  return {
    kind: "route.changed",
    from: { provider: from.provider, model: from.model },
    to: { provider: to.provider, model: to.model },
    fromActionId: previous.action.id,
  };
}

export interface ExecutorOptions {
  /** Durable retry schedule port; the default commits the `retry.scheduled` chain action through the ledger (core/alarm). */
  readonly retryAlarm?: RetryAlarmPort;
  readonly signal?: AbortSignal;
  readonly retainEffect?: (effect: Promise<void>) => void;
  readonly closeGraceMs?: number;
  readonly approvalTimeoutMs?: number;
  /**
   * The composed approval policy (#1309): responders, recent-open quota and
   * the default expiry. Required — the core keeps no literal fallback.
   */
  readonly approvalPolicy: ApprovalPolicy;
  readonly ledger: ExecutionLedger;
  readonly identity: ExecutionIdentity;
  readonly extensionKinds?: readonly ExecutionKindRegistration[];
  readonly authorizeApproval?: (
    credential: string,
    request: ExecutionApprovalRequest,
  ) => Effect.Effect<OwnerApprovalEvidence, ExecutionError>;
}

/** Package-private resolved values; public acquisition accepts no service options. */
export interface ResolvedExecutorOptions extends ExecutorOptions {
  readonly policy: CompiledPolicySnapshot;
  readonly observations: ObservationPort | BusEvent.Sink;
  readonly clock: () => number;
  readonly entropy: () => string;
  /** Uniform [0,1) draw for retry jitter; injected beside clock/entropy (#1245). */
  readonly random: () => number;
}

// ─── from executor-raw.ts (#1247) ───
export class RawToolSlots extends Context.Service<
  RawToolSlots,
  ReturnType<typeof createRawSlots>
>()("@openomni/agent/RawToolSlots") {}

/** Slots outlive interrupted fibers; raw callbacks only settle ownership, never ledger results. */
export function createRawSlots(retain?: (settlement: Promise<void>) => void) {
  const pending = new Map<symbol, Deferred.Deferred<void>>();
  function open() {
    const key = Symbol("raw-tool-slot");
    const completion = Promise.withResolvers<void>();
    const settled = Deferred.makeUnsafe<void>();
    pending.set(key, settled);
    retain?.(completion.promise);
    return () => {
      if (!pending.delete(key)) return;
      completion.resolve();
      Deferred.doneUnsafe(settled, Exit.void);
    };
  }
  // Re-check after the snapshot drains: slots opened meanwhile must settle too.
  const awaitSettled: Effect.Effect<void> = Effect.suspend(() => pending.size === 0 ? Effect.void
    : Effect.forEach([...pending.values()], Deferred.await, { discard: true }).pipe(Effect.andThen(awaitSettled)));
  return { open, awaitSettled, pending: () => pending.size };
}

export class GenerationRawSlots extends Context.Service<
  GenerationRawSlots, ReturnType<typeof createRawSlots>
>()("@openomni/agent/GenerationRawSlots") {}

// ─── from executor-outcome.ts (#1247) ───
export function failureEvidence(error: ExecutionError): PlainObject {
  switch (error._tag) {
    case "LlmRunFailure":
      return {
        tag: error._tag,
        message: error.message,
        providerErrorName: error.cause instanceof Error ? error.cause.name : null,
        retryAfterMs: error.retryAfterMs ?? null,
        usage: error.usage,
        aborted: error.aborted,
        contextOverflow: error.contextOverflow,
        visibleOutput: error.visibleOutput,
        cause: error.cause instanceof Error ? error.cause.message : typeof error.cause === "string" ? error.cause : null,
      };
    case "PolicyDenied":
      return { tag: error._tag, phase: error.phase, ruleIds: [...error.ruleIds] };
    case "ToolBodyFailed":
      return { tag: error._tag, tool: error.tool, cause: renderBodyCause(error.cause) };
    case "InvocationClosed":
      return { tag: error._tag, tool: error.tool, reason: error.reason };
    case "GenerationUnavailable":
      return { tag: error._tag, generation: error.generation };
    case "AgentFailure":
      return { tag: error._tag, operation: error.operation, cause: renderBodyCause(error.cause) };
    case "CompactionExecutionError":
      return { tag: error._tag, reason: error.reason };
    case "CommitFailed":
      return { tag: error._tag, ledgerTag: error.error._tag, cause: String(error.error) };
    case "ExecutionApprovalError":
      return { tag: error._tag, code: error.code };
    case "OutcomeUnknown":
      return { tag: error._tag, reason: error.reason };
    case "Interrupted":
      return { tag: error._tag };
    case "ContextAdmissionError":
      return { tag: error._tag };
    case "AgentStopError":
      return { tag: error._tag, code: error.code, reason: error.reason };
  }
}

function causeEvidence(cause: Cause.Cause<ExecutionError>): PlainObject {
  return {
    failures: cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error).map(failureEvidence),
    defects: Cause.hasDies(cause)
      ? Cause.prettyErrors(Cause.fromReasons(cause.reasons.filter(Cause.isDieReason))).map((error) => ({
          name: error.name,
          cause: error.message,
        }))
      : [],
    interrupted: Cause.hasInterrupts(cause),
  };
}

// ─── from executor-context.ts (#1247) ───
const invocationLifetime = Symbol("invocationLifetime");
interface InvocationLifetime {
  readonly source: InvocationFrame;
  readonly failure: () => InvocationClosed | GenerationUnavailable | undefined;
}

export interface InvocationFrame {
  readonly [invocationLifetime]?: InvocationLifetime;
  readonly executor: Executor;
  readonly cell: Dispatcher;
  readonly policy: CompiledPolicySnapshot;
  readonly generation: CapturedGeneration;
}
export const activeInvocation = new AsyncLocalStorage<{ readonly executor: Executor; readonly captured?: InvocationFrame }>();
export class ExecutorContext extends Context.Service<ExecutorContext, Executor>()("@openomni/agent/ExecutorContext") {}

export const executorContext = Effect.serviceOption(ExecutorContext).pipe(
  Effect.map((native) => Option.getOrElse(native, currentExecutor)),
);

export class ExecutorContextError extends Error {
  readonly code = "executor_context_missing";
  constructor() {
    super("executor context is required");
    this.name = "ExecutorContextError";
  }
}

/** The one guard over rebuilt executor context: absent context is a programmer invariant and dies. */
export function requireExecutor<T>(value: T | undefined): T {
  if (value === undefined) throw new ExecutorContextError();
  return value;
}

export function currentExecutor(): Executor {
  return requireExecutor(activeInvocation.getStore()?.executor);
}

/** Re-enter only executor authority; callers must not carry unrelated ALS scopes across RPC. */
export function withExecutor<T>(executor: Executor, body: () => T): T {
  const frame = activeInvocation.getStore();
  return activeInvocation.run(frame?.executor === executor ? frame : { executor }, body);
}

export function currentInvocation(): InvocationFrame {
  return requireExecutor(activeInvocation.getStore()?.captured);
}

export function requireOpenInvocation(): InvocationFrame {
  const frame = currentInvocation();
  const failure = frame[invocationLifetime]?.failure();
  if (failure !== undefined) throw failure;
  return frame;
}

/** Transfer a live invocation's captured authority to an independently owned lifetime. */
export function forkInvocation(tool: string) {
  const frame = requireOpenInvocation();
  return openInvocation(frame[invocationLifetime]?.source ?? frame, tool);
}

/** A turn's frame is a template; each admitted body owns a separately revocable view. */
export function openInvocation(frame: InvocationFrame, tool: string) {
  let reason: InvocationClosed["reason"] | undefined;
  const closed = new AbortController();
  const failure = (): InvocationClosed | GenerationUnavailable | undefined => {
    if (reason !== undefined) return new InvocationClosed({ tool, reason });
    if (!frame.generation.isSelected())
      return new GenerationUnavailable({ generation: frame.generation.id.generation });
    return undefined;
  };
  const awaitClose = onAbort(closed.signal, Effect.suspend(() => Effect.fail(new InvocationClosed({ tool, reason: reason ?? "interrupted" }))));
  const guard = <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.suspend<A, E | InvocationClosed | GenerationUnavailable, R>(() => {
    const error = failure();
    return error === undefined ? Effect.raceFirst(frame.generation.provide(work), awaitClose) : Effect.fail(error);
  });
  const { runBatch, runAttempts, recover, judgeStop, approvals } = frame.executor;
  const executor: Executor = {
    run: (request, body) => guard(frame.executor.run(request, body)),
    ...(runBatch === undefined ? {} : {
      runBatch: ((items, control) => guard(runBatch(items, control))) satisfies NonNullable<Executor["runBatch"]>,
    }),
    ...(runAttempts === undefined ? {} : {
      runAttempts: ((parent, attempts) => guard(runAttempts(parent, attempts))) satisfies NonNullable<Executor["runAttempts"]>,
    }),
    ...(recover === undefined ? {} : { recover: () => guard(recover()) }),
    ...(judgeStop === undefined ? {} : {
      judgeStop: ((...args) => guard(judgeStop(...args))) satisfies NonNullable<Executor["judgeStop"]>,
    }),
    ...(approvals === undefined ? {} : { approvals: {
      ...approvals, answer: (answer: Parameters<typeof approvals.answer>[0]) => guard(approvals.answer(answer)),
    } }),
  };
  const cell: Dispatcher = {
    ...frame.cell, executor,
    execute: (call, context) => guard(frame.cell.execute(call, context)),
    executeCell: (call, context) => guard(frame.cell.executeCell(call, context)),
    executeWave: (calls, context) => guard(frame.cell.executeWave(calls, context)),
    recover: (actions, context) => guard(frame.cell.recover(actions, context)),
  };
  return {
    frame: { ...frame, executor, cell, [invocationLifetime]: { source: frame, failure } } satisfies InvocationFrame,
    close: (next: InvocationClosed["reason"]) => {
      if (reason !== undefined) return;
      reason = next;
      closed.abort();
    },
  };
}

export function withInvocation<T>(frame: InvocationFrame, body: () => T): T {
  return activeInvocation.run({ executor: frame.executor, captured: frame }, body);
}

// ─── from executor-record.ts (#1247) ───
type ToolObservationStatus = "success" | "error" | "timed_out";

interface ActionSubject {
  readonly kind: LedgerAction.Kind;
  readonly op: string;
}

/** One record-before-observe adapter over the session's existing fenced ledger port. */
function createExecutionRecord(
  options: Pick<ResolvedExecutorOptions, "ledger" | "observations" | "identity" | "clock" | "entropy">,
) {
  function commit(action: LedgerAction.Append): Effect.Effect<LedgerAction.Receipt, CommitFailed> {
    return options.ledger.commit(action).pipe(
      Effect.mapError((error) => new CommitFailed({ error })),
      Effect.map((receipt) => {
        options.observations.publish(L0Observation.ActionCommittedEvent, {
          id: receipt.action.id,
          sessionId: receipt.action.sessionId,
          revision: receipt.revision,
          kind: receipt.action.kind,
        });
        return receipt;
      }),
    );
  }

  function publishToolStarted(request: ExecutionRequest): number | undefined {
    const identity = request.toolObservation;
    if (request.kind !== "tool" || identity === undefined) return undefined;
    const startedAt = options.clock();
    scopedObservations(identity).publish(Tool.Events.Started, {
      ...toolEventIdentity(request, identity),
      time: startedAt,
    });
    return startedAt;
  }

  function publishToolTerminal(
    request: ExecutionRequest,
    startedAt: number | undefined,
    status: ToolObservationStatus,
  ): void {
    const identity = request.toolObservation;
    if (request.kind !== "tool" || identity === undefined || startedAt === undefined) return;
    const observations = scopedObservations(identity);
    if (status === "timed_out") {
      observations.publish(Tool.Events.TimedOut, {
        ...toolEventIdentity(request, identity),
        time: options.clock(),
        timeoutMs: identity.timeoutMs ?? 0,
      });
    }
    const time = options.clock();
    observations.publish(Tool.Events.Completed, {
      ...toolEventIdentity(request, identity),
      time,
      durationMs: Math.max(0, time - startedAt),
      isError: status !== "success",
    });
  }

  function toolEventIdentity(request: ExecutionRequest, identity: ToolObservationIdentity) {
    return {
      traceId: identity.turnId,
      sessionId: options.identity.sessionId,
      runId: identity.turnId,
      toolCallId: identity.callId,
      toolName: request.op,
    };
  }

  function scopedObservations(identity: ToolObservationIdentity): ObservationPort | BusEvent.Sink {
    if (!("scope" in options.observations) || options.observations.scope === undefined) {
      return options.observations;
    }
    return options.observations.scope({
      traceId: identity.turnId,
      sessionId: options.identity.sessionId,
      turnId: identity.turnId,
      callId: identity.callId,
    });
  }

  function appendIntent(input: {
    readonly kind: LedgerAction.Kind;
    readonly op: string;
    readonly parentId: string | null;
    readonly value: PlainValue;
    readonly originalArgs?: PlainValue;
    readonly invocation?: PlainObject;
  }): Effect.Effect<LedgerAction.Receipt, CommitFailed> {
    return commit(
      actionAppend(
        input,
        {
          encodingVersion: 1,
          value: {
            phase: "intent",
            op: input.op,
            value: input.value,
            ...(input.originalArgs === undefined ? {} : { originalArgs: input.originalArgs }),
            ...input.invocation,
          },
        },
        { encodingVersion: 1, value: { phase: "pending" } },
      ),
    );
  }

  function appendResult(
    subject: ActionSubject,
    parentId: string,
    value: PlainValue,
    revert?: PlainValue,
  ): Effect.Effect<void, CommitFailed> {
    return Effect.suspend(() => {
      const action = actionAppend(
        { ...subject, parentId },
        { encodingVersion: 1, value: { phase: "result", op: subject.op } },
        { encodingVersion: 1, value },
      );
      if (revert === undefined) return Effect.asVoid(commit(action));
      return Effect.asVoid(commit({
        id: action.id,
        parentId: action.parentId,
        sessionId: action.sessionId,
        kind: action.kind,
        intent: action.intent,
        effect: action.effect,
        ts: action.ts,
        revert: { encodingVersion: 1, value: revert },
      }));
    });
  }

  function actionAppend(
    input: ActionSubject & { readonly parentId: string | null },
    intent: LedgerAction.Append["intent"],
    effect: LedgerAction.Append["effect"],
  ): LedgerAction.Append {
    return {
      id: options.entropy(),
      parentId: input.parentId,
      sessionId: options.identity.sessionId,
      kind: input.kind,
      intent,
      effect,
      ts: options.clock(),
      irreversible: true,
    };
  }

  return {
    commit,
    appendIntent,
    appendResult,
    publishToolStarted,
    publishToolTerminal,
  };
}

// ─── from executor-approval.ts (#1247) ───
type ApprovalDecision = "approve" | "refuse" | "timeout";

function createExecutionApprovals(options: ResolvedExecutorOptions) {
  const pending = new Map<string, {
    request: ExecutionApprovalRequest;
    signal: AbortSignal;
    decision: Deferred.Deferred<ApprovalDecision>;
    revisions?: () => Readonly<Record<string, number>>;
  }>();
  function transition(payload: SessionTransition.Payload, inputId: string) {
    return options.ledger.transition === undefined
      ? Effect.fail(new ExecutionApprovalError({ code: "approval_authority_unavailable" }))
      : options.ledger.transition(payload, inputId, options.clock());
  }
  function notify(request: SessionTransition.Request) {
    const persisted = options.ledger.requestById?.(request.requestId);
    const suspended = pending.get(request.requestId);
    if (suspended === undefined || persisted === undefined || persisted.state === "open") return;
    const value = persisted.state === "resolved" ? "approve"
      : persisted.state === "expired" ? "timeout" : "refuse";
    Deferred.doneUnsafe(suspended.decision, Exit.succeed(value));
  }
  const approvals: ExecutionApprovals = {
    pending: () => [...pending.values()].map((value) => structuredClone(value.request)),
    notify,
    answer: (answer) => Effect.gen(function* () {
      const suspended = pending.get(answer.request.id);
      const valid = () =>
        suspended !== undefined &&
        !suspended.signal.aborted &&
        pending.get(answer.request.id) === suspended &&
        canonicalDigest(PlainValueSchema.parse(answer.request)) ===
          canonicalDigest(PlainValueSchema.parse(suspended.request)) &&
        (suspended.revisions === undefined ||
          canonicalDigest({ ...suspended.revisions() }) ===
            canonicalDigest(suspended.request.durable.domainRevisions));
      if (!valid() || suspended === undefined)
        return yield* new ExecutionApprovalError({ code: "stale_approval" });
      if (options.authorizeApproval === undefined)
        return yield* new ExecutionApprovalError({ code: "approval_authority_unavailable" });
      const principal = yield* options.authorizeApproval(answer.credential, suspended.request);
      if (!valid()) return yield* new ExecutionApprovalError({ code: "stale_approval" });
      const request = suspended.request.durable;
      const input: SessionTransition.Answer = {
        inputId: `${request.requestId}:owner-answer`,
        requestId: request.requestId,
        sessionId: request.sessionId,
        receivedAt: options.clock(),
        principal,
        bindingDigest: request.bindingDigest,
        inputHash: request.inputHash,
        effectHash: request.effectHash,
        generation: request.generation,
        toolsHash: request.toolsHash,
        domainRevisions: request.domainRevisions,
        decision: answer.decision,
        allowedAction: "report_result",
        content: answer.decision,
      };
      const result = yield* transition({ kind: "request.answer", answer: input }, input.inputId);
      if (result.request !== undefined) notify(result.request);
      if (result.request === undefined || !["resolved", "refused"].includes(result.resolution))
        return yield* new ExecutionApprovalError({ code: "stale_approval" });
    }),
  };
  function awaitApproval(
    captured: Omit<ExecutionApprovalRequest, "durable">,
    signal: AbortSignal,
    binding: {
      effect: PlainValue;
      domainRevisions?: Readonly<Record<string, number>>;
      revisions?: () => Readonly<Record<string, number>>;
      timeoutMs?: number;
      original?: SessionTransition.Request;
    },
  ): Effect.Effect<ApprovalDecision, ExecutionError> {
    return Effect.gen(function* () {
      const timeout = binding.timeoutMs ?? options.approvalTimeoutMs ?? options.approvalPolicy.defaultExpiryMs;
      const durable = binding.original ??
        createApprovalRequest(captured, binding, options.identity.systemHash, options.clock(), timeout, options.approvalPolicy.responders);
      const request: ExecutionApprovalRequest = { ...captured, expiresAt: durable.deadline, durable };
      const decision = yield* Deferred.make<ApprovalDecision>();
      pending.set(request.id, { request, signal, decision, revisions: binding.revisions });
      const cancel = transition({
        kind: "request.cancel",
        requestId: request.id,
        principal: { kind: "session", principalId: request.sessionId, evidenceId: request.id },
      }, `${request.id}:cancel`).pipe(Effect.as("refuse" as const));
      const wait = Effect.gen(function* () {
        if (binding.original === undefined) {
          const opened = yield* transition({ kind: "request.open", request: durable }, `${request.id}:open`);
          if (opened.resolution !== "opened")
            return yield* new ExecutionApprovalError({ code: "stale_approval" });
        }
        notify(durable);
        return yield* Deferred.await(decision).pipe(Effect.raceFirst(onAbort(signal, Effect.void).pipe(Effect.andThen(cancel))));
      });
      return yield* wait.pipe(
        Effect.onInterrupt(() => Effect.orDie(cancel)),
        Effect.ensuring(Effect.sync(() => pending.delete(request.id))),
      );
    });
  }
  return { approvals, awaitApproval };
}

// ─── from executor-attempts.ts (#1247) ───
type RecordPort = ReturnType<typeof createExecutionRecord>;
type Admission = PolicyEvaluation & { readonly receipt: LedgerAction.Receipt };
type Prepared<T extends PlainValue> = Effect.Success<ReturnType<LlmAttempts<T>["prepare"]>>;

function terminalFailure(failure: ExecutionError, attempt: number) {
  if (failure._tag === "LlmRunFailure") attachFailureFacts(failure, {
    reason: failure.aborted ? "aborted" : Retry.attemptReason(failure), attempt, maxAttempts: Retry.MAX_ATTEMPTS, llm: true,
  });
  return Effect.fail(failure);
}
function retryableFailure(cause: Cause.Cause<ExecutionError>) {
  const error = Cause.findErrorOption(cause);
  return Cause.hasInterrupts(cause) || Cause.hasDies(cause) || Option.isNone(error)
    ? Effect.failCause(cause) : Effect.succeed(error.value);
}

/** No replay after a visible delta or an abort: the attempt is terminal. */
function failureRequiresStop(failure: ExecutionError, signal: AbortSignal | undefined): boolean {
  if (failure._tag === "CommitFailed" || signal?.aborted === true) return true;
  return failure._tag === "LlmRunFailure" && (failure.aborted || failure.visibleOutput);
}
function retryDelay(recover: boolean, decision: ReturnType<typeof Retry.decide>): number {
  return !recover && decision.retry ? decision.delayMs : 0;
}

function usageProvenance(evidence: PlainValue, failure: ExecutionError | undefined) {
  const record = evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)
    ? evidence : {};
  const origin = failure?._tag === "LlmRunFailure" ? failure.usageProvenance : record.usageProvenance;
  return origin === "reported" || origin === "estimated" ? origin : "unknown";
}

/**
 * Default durable retry port over the alarm chain (#1254 S4): `arm` commits
 * the `alarm{arm}` chain row (purpose `retry`) through the session ledger and
 * forwards the minted occurrence through `send`; `settle` retires the chain
 * with an `at: null` arm. Without a cluster client there is no DeliverAt
 * sender: the chain row is the durable evidence the activation resend
 * consumes, and the live residual sleep carries the in-process wait.
 * Composition injects the sender via `ExecutorOptions.retryAlarm`.
 */
export function createLedgerRetryAlarmPort(
  ledger: Pick<ExecutionLedger, "commit">,
  sessionId: string,
  clock: () => number,
  send: RetryAlarmDeps["send"] = () => Effect.void,
): RetryAlarmPort {
  return createRetryAlarmPort({
    sessionId,
    commitArm: (action) =>
      ledger
        .commit(LedgerAction.Append.parse(action))
        .pipe(
          Effect.mapError((error) => new CommitFailed({ error })),
          Effect.asVoid,
        ),
    send,
    clock,
  });
}

function createAttemptRunner(
  options: ResolvedExecutorOptions,
  record: Pick<RecordPort, "appendIntent" | "appendResult">,
  admit: (request: AttemptRequest, parent: LedgerAction.Receipt) => Effect.Effect<Admission, ExecutionError>,
  approve: (request: AttemptRequest, intent: LedgerAction.Receipt, admission: Admission) => Effect.Effect<"approve" | "refuse" | "timeout", ExecutionError>,
) {
  const retryAlarm = options.retryAlarm ?? createLedgerRetryAlarmPort(options.ledger, options.identity.sessionId, options.clock);
  function approveAttempt(request: AttemptRequest, intent: LedgerAction.Receipt, policy: Admission | undefined) {
    if (policy?.verdict !== "require_approval") return Effect.void;
    return Effect.gen(function* () {
      const decision = yield* approve(request, intent, policy);
      if (decision === "approve") return;
      yield* record.appendResult({ kind: "llm", op: request.op }, intent.action.id, {
        phase: "result", terminal: "blocked_pre", reason: decision === "timeout" ? "approval_timeout" : "approval_refused",
      });
      return yield* new PolicyDenied({ phase: "pre", ruleIds: policy.matchedRuleIds });
    });
  }
  function admitAttempt<T extends PlainValue>(parent: LedgerAction.Receipt, attempts: LlmAttempts<T>, attempt: number, failures: readonly string[], previous: LedgerAction.Receipt | undefined): Effect.Effect<{ prepared: Prepared<T>; intent: LedgerAction.Receipt }, ExecutionError> {
    return attempts.prepare(attempt, failures).pipe(Effect.flatMap((prepared) => {
      const policyEffect: Effect.Effect<Admission | undefined, ExecutionError> = attempt === 1
        ? Effect.succeed<Admission | undefined>(undefined)
        : admit(prepared.request, parent);
      return policyEffect.pipe(Effect.flatMap((policy) => {
        if (policy !== undefined && (policy.verdict === "deny" || policy.verdict === "transform"))
          return Effect.fail(new PolicyDenied({ phase: "pre", ruleIds: policy.matchedRuleIds }));
        return prepared.admit().pipe(
          Effect.flatMap((): Effect.Effect<void, ExecutionError> => options.signal?.aborted ? Effect.interrupt : Effect.void),
          Effect.flatMap(() => record.appendIntent({
            kind: "llm", op: prepared.request.op, parentId: parent.action.id, value: prepared.request.intent,
            invocation: {
              effectHash: canonicalDigest(prepared.request.effect), attempt, maxAttempts: Retry.MAX_ATTEMPTS,
              retryReason: failures.at(-1) ?? null,
              routeChange: attemptRouteChange(previous, prepared.request.intent),
            },
          })),
          Effect.flatMap((intent) => approveAttempt(prepared.request, intent, policy).pipe(
            Effect.as({ prepared, intent }),
          )),
        );
      }));
    }));
  }
  function executeAttempt<T extends PlainValue>(prepared: Prepared<T>, attempts: LlmAttempts<T>, intent: LedgerAction.Receipt) {
    return Effect.uninterruptibleMask((restore) =>
      Effect.exit(restore(prepared.body())).pipe(
        Effect.flatMap((exit) => {
          const evidence = Exit.isSuccess(exit) ? attempts.evidence?.(exit.value) ?? null : causeEvidence(exit.cause);
          const failure = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
          return record.appendResult({ kind: "llm", op: prepared.request.op }, intent.action.id, {
            phase: "result", effect: prepared.request.effect,
            terminal: Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) ? "interrupted" : "executed",
            usageProvenance: usageProvenance(evidence, failure),
            evidence,
          }).pipe(Effect.as(exit));
        }),
      ),
    );
  }
  function scheduleRetry<T extends PlainValue>(attempts: LlmAttempts<T>, failure: ExecutionError, attempt: number, instantFailures: number, prepared: Prepared<T>, intent: LedgerAction.Receipt) {
    return Effect.gen(function* () {
      if (failureRequiresStop(failure, options.signal)) return yield* terminalFailure(failure, attempt);
      const overflow = Retry.isContextOverflow(failure);
      const decision = Retry.decide(attempt, failure, { now: options.clock, random: options.random }, instantFailures, prepared.fallbackAvailable);
      if (attempt >= Retry.MAX_ATTEMPTS) return yield* terminalFailure(failure, attempt);
      const recover = overflow && (yield* attempts.recoverOverflow?.(failure) ?? Effect.succeed(false));
      if (!recover && (overflow || !decision.retry)) return yield* terminalFailure(failure, attempt);
      const delayMs = retryDelay(recover, decision);
      const reason = recover ? "context_overflow" : Retry.attemptReason(failure);
      attempts.onRetry?.({ attempt, maxAttempts: Retry.MAX_ATTEMPTS, delayMs, decision, error: failure, reason });
      const id = intent.action.id;
      const fireAt = options.clock() + delayMs;
      yield* retryAlarm.arm({ id, attempt, reason, fireAt });
      yield* retryAlarm.wait(fireAt, options.signal);
      yield* retryAlarm.settle({ id, attempt });
      return reason;
    });
  }
  return function runAttempts<T extends PlainValue>(parent: LedgerAction.Receipt, attempts: LlmAttempts<T>): Effect.Effect<T, ExecutionError> {
    return Effect.suspend(() => {
      const failures: string[] = [];
      let instantFailures = 0;
      let previous: LedgerAction.Receipt | undefined;
      const loop = (attempt: number): Effect.Effect<T, ExecutionError> => {
        if (options.signal?.aborted) return Effect.interrupt;
        return admitAttempt(parent, attempts, attempt, failures, previous).pipe(Effect.flatMap(({ prepared, intent }) => {
          previous = intent;
          const started = options.clock();
          return executeAttempt(prepared, attempts, intent).pipe(Effect.flatMap((outcome) => {
            if (Exit.isSuccess(outcome)) return Effect.succeed(outcome.value);
            return retryableFailure(outcome.cause).pipe(Effect.flatMap((failure: ExecutionError): Effect.Effect<T, ExecutionError> => {
              instantFailures = Retry.isInstantTransportFailure(failure, options.clock() - started) ? instantFailures + 1 : 0;
              return scheduleRetry(attempts, failure, attempt, instantFailures, prepared, intent).pipe(
                Effect.flatMap((reason) => {
                  failures.push(reason);
                  return loop(attempt + 1);
                }),
              );
            }));
          }));
        }));
      };
      return loop(1);
    });
  };
}

// ─── from executor-stop.ts (#1247) ───
/** Projects limits from the captured compiler; never repeats policy row names or numeric limits. */
function createStopJudge(
  options: ResolvedExecutorOptions,
  decide: (op: string, value: PlainValue) => Effect.Effect<PolicyEvaluation, ExecutionError>,
  commit: (action: LedgerAction.Append) => Effect.Effect<LedgerAction.Receipt, ExecutionError>,
) {
  return (state: StopState, observation: StopObservation) => Effect.gen(function* () {
    function limit(metric: StopMetric): Effect.Effect<number, ExecutionError> {
      return Effect.gen(function* () {
      const op = metric === "continuation" ? "continue" : metric;
      const decision = yield* decide(op, { metric });
      const rows = decision.obligations.filter(
        (row) => row.ref === "kernel/budget-clamp" && row.metric === metric,
      );
      const row = rows[0];
      if (
        decision.verdict === "deny" ||
        decision.verdict === "require_approval" ||
        decision.verdict === "transform" ||
        decision.generation !== options.policy.generation ||
        rows.length !== 1 ||
        row === undefined ||
        row.limit <= 0 ||
        !Number.isInteger(row.limit)
      )
        return yield* new AgentFailure({ operation: "stop.policy", cause: `invalid_stop_policy:${metric}` });
      return row.limit;
      });
    }
    const result = yield* judgeStop(state, observation, limit, () => Effect.gen(function* () {
      const completion = yield* decide("completion", {
        text: observation.text,
        openIntent: [...observation.openIntent],
      });
      return completion.verdict === "allow";
    }));
    yield* commit(turnStopAction({
      id: options.entropy(),
      sessionId: options.identity.sessionId,
      parentId: options.identity.parentActionId,
      generation: options.policy.generation,
      verdict:
        result.verdict.kind === "waiting"
          ? { kind: "waiting", reason: "live_wait", alarmIds: [...result.verdict.alarmIds] }
          : { ...result.verdict },
      state: { ...result.state },
      ts: options.clock(),
    }));
    return result;
  });
}

// ─── from executor-recovery.ts (#1247) ───
type RecoveryRecordPort = Pick<ReturnType<typeof createExecutionRecord>, "appendResult">;
type Proof = "absent" | "applied" | "indeterminate";

interface RecoveryVerdict {
  readonly terminal: "interrupted" | "outcome_unknown";
  readonly classification: RecoveryClassification;
  readonly proof: Proof;
  readonly proofReceipt: { readonly id: string; readonly digest: string } | null;
}

/** Kernel-local projections settle in the ledger transaction; everything else may have left the process. */
function recoveryClassification(
  request: Pick<ExecutionRequest, "kind" | "recovery">,
): RecoveryClassification {
  if (request.recovery !== undefined) return request.recovery;
  return request.kind === "compaction" || request.kind === "message"
    ? "local_transactional"
    : "ambiguous_no_replay";
}

function object(value: PlainValue | undefined): PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const classifications: readonly RecoveryClassification[] = [
  "local_transactional",
  "endpoint_idempotent",
  "read_back_reconcilable",
  "ambiguous_no_replay",
];

/** The classification the intent recorded, or undefined when it recorded none it can be held to. */
function recordedClassification(value: PlainValue | undefined): RecoveryClassification | undefined {
  return classifications.find((classification) => classification === value);
}

/** The ledger itself is the read-back for a kernel-local transaction: no terminal means nothing happened. */
function localAbsent(receipt: LedgerAction.Node): RecoveryVerdict {
  return {
    terminal: "interrupted",
    classification: "local_transactional",
    proof: "absent",
    proofReceipt: { id: receipt.id, digest: canonicalDigest(receipt.effect.value) },
  };
}

/** Without external read-back, only an absent local transaction is decisive. */
function crashVerdict(action: LedgerAction.Node): RecoveryVerdict {
  const classification =
    recordedClassification(object(action.intent.value).recovery) ??
    recoveryClassification({ kind: action.kind });
  if (classification === "local_transactional") return localAbsent(action);
  return {
    terminal: "outcome_unknown",
    classification,
    proof: "indeterminate",
    proofReceipt: null,
  };
}

/**
 * Recovery reads the original terminal slot first and never runs a body.
 * A refused recovery commit propagates: the durable intent stays recovery-pending.
 */
function createExecutionRecovery(options: ExecutorOptions, record: RecoveryRecordPort) {
  function terminal(intentId: string): LedgerAction.Node | undefined {
    return options.ledger.resultFor?.(intentId);
  }

  function settleCrash(
    action: LedgerAction.Node,
    verdict: RecoveryVerdict,
  ): Effect.Effect<void, CommitFailed> {
    const intent = object(action.intent.value);
    const callId = typeof intent.callId === "string" ? intent.callId : undefined;
    return record.appendResult({ kind: action.kind, op: String(intent.op) }, action.id, {
      phase: "result",
      terminal: verdict.terminal,
      effect: intent.effect ?? {},
      evidence: {
        failures: [{ tag: "OutcomeUnknown", reason: "process_lost" }],
        defects: [],
        interrupted: false,
      },
      error: { name: "ProcessLost" },
      ...(callId === undefined ? {} : { callId }),
      ...(action.kind === "tool" && callId !== undefined
        ? {
            toolResult: {
              id: callId,
              toolCallId: callId,
              toolName: String(intent.op),
              output: `${String(intent.op)} outcome unknown: the process was lost before a result was recorded`,
              isError: true,
              settlement: verdict.terminal === "outcome_unknown" ? "unknown" : "settled",
            },
          }
        : {}),
      recovery: {
        site: "crash",
        classification: verdict.classification,
        proof: verdict.proof,
        proofReceipt: verdict.proofReceipt,
        revertReceipt: null,
        rawSettled: false,
      },
    });
  }

  /** The committed boundary child, when the body's transaction landed before the crash. */
  function boundaryEvidence(intentId: string): LedgerAction.Node | undefined {
    const action = options.ledger.actionById?.(`${intentId}:boundary`);
    return action !== undefined && object(action.effect.value).phase === "boundary"
      ? action
      : undefined;
  }

  /** Settle the open intent as executed from its durable boundary, never re-running the body. */
  function settleFromBoundary(
    action: LedgerAction.Node,
    boundary: LedgerAction.Node,
  ): Effect.Effect<void, CommitFailed> {
    const intent = object(action.intent.value);
    const result = object(boundary.effect.value).result ?? null;
    const revert = object(result).revert;
    return record.appendResult(
      { kind: action.kind, op: String(intent.op) },
      action.id,
      {
        phase: "result",
        terminal: "executed",
        effect: intent.effect ?? {},
        resultHash: canonicalDigest(result),
        result,
        recovery: {
          site: "crash",
          classification: "local_transactional",
          proof: "applied",
          proofReceipt: { id: boundary.id, digest: canonicalDigest(boundary.effect.value) },
          revertReceipt: null,
          rawSettled: true,
        },
      },
      revert,
    );
  }

  /** An open attempt or an already visible prefix cannot be proven absent.
   * Only non-visible settled attempts leave a purely local commit to recover. */
  function settleLlm(action: LedgerAction.Node) {
    return Effect.gen(function* () {
      let ambiguous = false;
      let lastSettled: LedgerAction.Node = action;
      for (const attempt of operationRecords(options.ledger.operationChildrenPage, action.id)) {
        if (attempt.kind !== "llm" || attempt.parentId !== action.id) continue;
        if (object(attempt.intent.value).phase !== "intent") continue;
        const settled = terminal(attempt.id);
        if (settled !== undefined) {
          lastSettled = settled;
          ambiguous ||= hasVisiblePrefix(settled);
          continue;
        }
        ambiguous = true;
        yield* settleCrash(attempt, crashVerdict(attempt));
      }
      yield* settleCrash(action, ambiguous ? crashVerdict(action) : localAbsent(lastSettled));
    });
  }

  /** Crash-open settlement for this turn: persisted evidence only, no body, guarded waves stay with their captured dispatcher. */
  function recover(): Effect.Effect<void, CommitFailed> {
    return Effect.gen(function* () {
      const turnId = options.identity.turnId ?? options.identity.parentActionId;
      if (turnId === null) return;
      for (const action of operationRecords(options.ledger.openOperationsPage, turnId)) {
        if (action.kind !== "llm") {
          const boundary = boundaryEvidence(action.id);
          if (boundary === undefined) yield* settleCrash(action, crashVerdict(action));
          else yield* settleFromBoundary(action, boundary);
          continue;
        }
        yield* settleLlm(action);
      }
    });
  }

  return { recover };
}

function hasVisiblePrefix(action: LedgerAction.Node): boolean {
  const evidence = object(object(action.effect.value).evidence);
  if (evidence.visibleOutput === true) return true;
  return Array.isArray(evidence.failures) &&
    evidence.failures.some((failure) => object(failure).visibleOutput === true);
}

function* operationRecords(
  read: ExecutorOptions["ledger"]["openOperationsPage"],
  id: string,
): Generator<LedgerAction.Node> {
  let cursor = 0;
  for (;;) {
    const page = read?.(id, cursor) ?? [];
    yield* page;
    if (page.length < 256) return;
    cursor = page.at(-1)?.ordinal ?? cursor;
  }
}

// ─── from executor.ts (#1247) ───
/** Raw-slot settlement grace after body exit: an explicit executor-owned default (W5.2). */
const DEFAULT_CLOSE_GRACE_MS = 30_000;
const CORE_KINDS = new Set(["prompt", "turn", "llm", "tool", "compaction", "message"]);
type Decision = PolicyEvaluation & { readonly receipt: LedgerAction.Receipt };
type Admitted = Pick<Decision, "generation" | "receipt" | "verdict" | "value" | "reason" | "transforms">;
type Restore = Parameters<Parameters<typeof Effect.uninterruptibleMask>[0]>[0];
type Stage<R> = {
  readonly item: ExecutionBatchItem<R>;
  readonly request: ExecutionRequest;
  readonly kind: LedgerAction.Kind;
  readonly pre: Admitted;
  readonly intent: LedgerAction.Receipt | undefined;
};
type BodyExit = {
  readonly exit: Exit.Exit<PlainValue, ExecutionError>;
  readonly startedAt: number | undefined;
  readonly rawPending: boolean;
};

function combinedSignal(controller: AbortSignal, control: AbortSignal, caller: AbortSignal | undefined): AbortSignal {
  return AbortSignal.any(caller === undefined ? [controller, control] : [controller, control, caller]);
}

function outcomeFields(outcome: ExecutionResult, project: (value: PlainValue) => PlainValue): PlainObject {
  // #1305: the row carries the projected value; resultHash stays the digest
  // of the FULL value, so replay identity survives the projection.
  if (outcome.terminal === "executed") return { result: project(outcome.value), resultHash: canonicalDigest(outcome.value) };
  return outcome.terminal === "blocked_post" ? { reason: outcome.reason, disposition: outcome.disposition } : { reason: outcome.reason };
}
function failedOutcome(cause: Cause.Cause<ExecutionError>, failure: ExecutionError): ExecutionResult {
  if (Cause.hasInterrupts(cause) || failure._tag === "Interrupted") return { terminal: "interrupted", reason: "fiber_interrupted" };
  return failure._tag === "OutcomeUnknown"
    ? { terminal: "outcome_unknown", reason: failure.reason }
    : { terminal: "executed", value: null, failure };
}

export function createExecutor(input: ExecutorOptions): Effect.Effect<DurableExecutor, ExecutionError, ProcessServices | SessionLayer> {
  return Effect.gen(function* () {
  if (input.approvalTimeoutMs !== undefined && (!Number.isSafeInteger(input.approvalTimeoutMs) || input.approvalTimeoutMs < 0))
    return yield* new AgentFailure({ operation: "executor.acquire", cause: "invalid_approval_timeout" });
  const clock = yield* Clock.clockWith(Effect.succeed);
  const entropy = yield* Entropy;
  const observations = yield* ObservationSink;
  const { policy } = yield* SessionLayer;
  const options = { ...input, clock: () => clock.currentTimeMillisUnsafe(), entropy: entropy.id, random: entropy.random, observations, policy };
  const record = createExecutionRecord(options);
  const { approvals, awaitApproval } = createExecutionApprovals(options);
  const recovery = createExecutionRecovery(options, record);
  const kinds = new Set([...CORE_KINDS, ...(options.extensionKinds ?? []).map((item) => item.kind)]);
  const turnId = options.identity.turnId ?? options.identity.parentActionId;
  /** #1305: tool rows commit a bounded projection; every other kind commits verbatim. */
  const projectValue = (kind: LedgerAction.Kind, value: PlainValue): PlainValue => {
    const put = options.ledger.putToolOutput;
    if (kind !== "tool" || put === undefined) return value;
    return projectResultValue(value, {
      budgetBytes: options.ledger.toolOutputBudgetBytes?.() ?? DEFAULT_TOOL_OUTPUT_BUDGET_BYTES,
      put,
    });
  };

  /** Registry lookup (#1251): a kind consults `<kind>.<phase>` only when that point is registered in the snapshot's composed table; there is no bypass — an extension kind without a point record fails closed. */
  function consulted(kind: string, phase: "pre" | "post"): boolean {
    return executionPoint(kind, phase, options.policy.pointTable) !== undefined;
  }
  /** An unregistered point fails closed: the registration table, not the row set, defines where policy applies. */
  function gatedByRegistry(evaluated: PolicyEvaluation, request: ExecutionRequest, phase: "pre" | "post"): PolicyEvaluation {
    if (consulted(request.kind, phase)) return evaluated;
    return { ...evaluated, verdict: "deny", reason: "unknown_point" };
  }
  function decide(request: ExecutionRequest, phase: "pre" | "post", value: PlainValue,
    parentId = options.identity.parentActionId): Effect.Effect<Decision, CommitFailed> {
    return Effect.suspend(() => {
      const input = {
        kind: request.kind, phase, op: request.op, role: options.identity.role, sessionId: options.identity.sessionId,
        ...(request.message === undefined ? {} : { message: request.message }), value,
      };
      // #1256: async consultants (hook rows) resolve through evaluateEffect;
      // a snapshot without one evaluates synchronously as before.
      const evaluatedEffect = options.policy.evaluateEffect === undefined
        ? Effect.sync(() => options.policy.evaluate(input))
        : options.policy.evaluateEffect(input);
      return evaluatedEffect.pipe(Effect.flatMap((evaluated) => {
      const decision = gatedByRegistry(evaluated, request, phase);
      return record.commit({
        id: options.entropy(), parentId, sessionId: options.identity.sessionId, kind: "policy.decision",
        intent: { encodingVersion: 1, value: decisionIntentValue(request, phase, decision) },
        effect: { encodingVersion: 1, value: {
          phase: "result", reason: decision.reason ?? null,
          ...(decision.verdict === "deny" ? {
            terminal: phase === "pre" ? "blocked_pre" : "blocked_post",
            evidence: { failures: [{ tag: "PolicyDenied", phase, ruleIds: [...decision.matchedRuleIds] }], defects: [], interrupted: false },
          } : {}),
        } },
        ts: options.clock(), irreversible: true,
      }).pipe(Effect.map((receipt) => ({ ...decision, receipt })));
      }));
    });
  }

  function invocationFor<R>(stage: Omit<Stage<R>, "intent">, waveId: string) {
    return {
      policyDecisionId: stage.pre.receipt.action.id,
      effectHash: canonicalDigest(stage.request.effect), effect: stage.request.effect,
      callId: stage.request.toolObservation?.callId ?? stage.pre.receipt.action.id,
      turnId, waveId,
      sequential: stage.item.sequential ?? false, approvalRequired: needsApproval(stage),
      domainRevisions: { ...stage.request.approval?.domainRevisions }, recovery: recoveryClassification(stage.request),
      toolsGeneration: options.identity.toolsGeneration ?? null,
      systemHash: options.identity.systemHash ?? null,
    };
  }

  function admit(request: ExecutionRequest): Effect.Effect<Admitted, ExecutionError> {
    const original = request.originalAction;
    if (original === undefined) return decide(request, "pre", request.intent);
    return Effect.try({
      try: () => recoverAdmission(options, request, original),
      catch: (cause) => cause instanceof ExecutionApprovalError ? cause : new AgentFailure({ operation: "executor.recover_admission", cause: thrownAsError(cause) }),
    });
  }

  /** Denied stages record nothing; recovered stages reuse the original intent; fresh stages append one. */
  function stageIntent<R>(stage: Omit<Stage<R>, "intent">, waveId: string): Effect.Effect<LedgerAction.Receipt | undefined, ExecutionError> {
    const original = stage.request.originalAction;
    if (stage.pre.verdict === "deny") return Effect.succeed(undefined);
    if (original !== undefined) return Effect.succeed({ action: original, revision: original.ordinal });
    return record.appendIntent({
      parentId: options.identity.parentActionId, kind: stage.kind, op: stage.request.op, value: stage.pre.value,
      ...(stage.pre.transforms.length === 0 ? {} : { originalArgs: stage.request.intent }),
      invocation: invocationFor(stage, waveId),
    });
  }

  function stageAll<R>(items: readonly ExecutionBatchItem<R>[]): Effect.Effect<Stage<R>[], ExecutionError> {
    const [item] = items;
    if (items.length === 1 && item !== undefined) {
      return Effect.suspend<Stage<R>[], ExecutionError, never>(() => {
        const request = { ...item.request, intent: structuredClone(item.request.intent) };
        if (!kinds.has(request.kind))
          return Effect.fail(new AgentFailure({ operation: "executor.admit", cause: `unregistered_execution_kind:${request.kind}` }));
        const kind = request.kind as LedgerAction.Kind;
        return admit(request).pipe(Effect.flatMap((pre) => {
          const stage = { item, request, kind, pre };
          return stageIntent(stage, pre.receipt.action.id).pipe(Effect.map((receipt) => [{ ...stage, intent: receipt }]));
        }));
      });
    }
    return Effect.gen(function* () {
      const staged: Omit<Stage<R>, "intent">[] = [];
      for (const item of items) {
        const request = { ...item.request, intent: structuredClone(item.request.intent) };
        if (!kinds.has(request.kind))
          return yield* new AgentFailure({ operation: "executor.admit", cause: `unregistered_execution_kind:${request.kind}` });
        const kind = request.kind as LedgerAction.Kind;
        const pre = yield* admit(request);
        staged.push({ item, request, kind, pre });
      }
      const admitted: Stage<R>[] = [];
      for (const stage of staged) {
        const intent = yield* stageIntent(stage, staged[0]?.pre.receipt.action.id ?? stage.pre.receipt.action.id);
        admitted.push({ ...stage, intent });
      }
      return admitted;
    });
  }

  function approval<R>(stage: Stage<R>, signal: AbortSignal) {
    const intent = stage.intent;
    const original = intent === undefined ? undefined : options.ledger.requestById?.(intent.action.id);
    if (intent === undefined || (!needsApproval(stage) && original === undefined))
      return Effect.succeed("approve" as const);
    return awaitApproval({
      id: intent.action.id, sessionId: options.identity.sessionId, turnId,
      toolsHash: options.identity.toolsHash, toolsGeneration: options.identity.toolsGeneration,
      callId: stage.request.toolObservation?.callId ?? intent.action.id,
      inputHash: canonicalDigest(stage.request.intent), generation: stage.pre.generation,
      revision: stage.pre.receipt.revision, policyDecisionId: stage.pre.receipt.action.id, intent: stage.request.intent,
    }, signal, {
      effect: stage.request.effect, domainRevisions: stage.request.approval?.domainRevisions,
      revisions: stage.request.domainRevisions, timeoutMs: stage.request.approval?.timeoutMs, original,
    });
  }

  function admittedBody<R>(stage: Stage<R>, guarded: boolean, started: () => void) {
    return Effect.suspend<PlainValue, ExecutionError, R>(() => {
      const intent = stage.intent;
      if (intent === undefined) return Effect.die("missing admitted intent");
      const captured = options.ledger.requestById?.(intent.action.id);
      assertFresh(stage.request, captured);
      const enter = (): Effect.Effect<PlainValue, ExecutionError, R> => {
        assertFresh(stage.request, captured);
        if (captured !== undefined && options.ledger.validateRequest?.(captured) === false)
          return Effect.fail(new ExecutionApprovalError({ code: "stale_approval" }));
        started();
        const admitted = object(intent.action.intent.value).value;
        if (admitted === undefined) return Effect.die("missing admitted input");
        return stage.item.body(intent, immutableInput(structuredClone(admitted)));
      };
      if (!guarded) return enter();
      const id = `${intent.action.id}:application`;
      if (options.ledger.actionById?.(id) !== undefined)
        return Effect.fail(new OutcomeUnknown({ reason: "application_already_entered" }));
      return record.commit({
        id, parentId: intent.action.id, sessionId: options.identity.sessionId, kind: stage.kind,
        intent: { encodingVersion: 1, value: { phase: "application", op: stage.request.op } },
        effect: { encodingVersion: 1, value: { phase: "application", inputHash: canonicalDigest(stage.request.intent) } },
        ts: options.clock(), irreversible: true,
      }).pipe(Effect.flatMap(enter));
    });
  }

  function executeBody<R>(stage: Stage<R>, signal: AbortSignal, guarded: boolean, settled: (body: BodyExit) => void) {
    return Effect.withFiber<void, never, Exclude<R, RawToolSlots | Scope.Scope>>((fiber) => Effect.uninterruptible(
      Effect.suspend(() => {
        const generation = Context.getOption(fiber.context, GenerationRawSlots);
        const slots = createRawSlots((settlement) => {
          if (Option.isSome(generation)) {
            const release = generation.value.open();
            void settlement.then(release);
          }
          options.retainEffect?.(settlement);
        });
        let startedAt: number | undefined;
        const body = admittedBody(stage, guarded, () => { startedAt = record.publishToolStarted(stage.request); });
        const owned = Effect.scopedWith((scope) => Effect.provide(
          body, Context.make(RawToolSlots, slots).pipe(Context.add(Scope.Scope, scope)),
        ));
        const detach = listenForAbort(signal, () => fiber.interruptUnsafe(fiber.id));
        const exitEffect = Effect.exit(Effect.interruptible(owned)).pipe(
          Effect.flatMap((exit) => {
            detach();
            if (slots.pending() === 0) return Effect.succeed(exit);
            const grace = Effect.forkScoped(Effect.interruptible(slots.awaitSettled).pipe(
              Effect.timeoutOption(options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS),
            ));
            return Effect.scoped(grace.pipe(Effect.flatMap(Fiber.join), Effect.as(exit)));
          }),
        );
        if (options.retainEffect === undefined)
          return exitEffect.pipe(Effect.flatMap((exit) => Effect.sync(() => {
            settled({ exit, startedAt, rawPending: slots.pending() > 0 });
          })));
        let completed: BodyExit | undefined;
        const settle = (body: BodyExit) => {
          if (completed !== undefined) return;
          completed = body;
          settled(body);
        };
        return exitEffect.pipe(
          Effect.flatMap((exit) => Effect.sync(() => {
            settle({ exit, startedAt, rawPending: slots.pending() > 0 });
          })),
          Effect.ensuring(Effect.sync(() => {
            if (completed === undefined)
              settle({ exit: Exit.fail(new Interrupted()), startedAt, rawPending: slots.pending() > 0 });
          })),
        );
      }),
    ));
  }

  function appendOutcome<R>(stage: Stage<R>, outcome: ExecutionResult, evidence: PlainObject = {}, project = true) {
    return Effect.suspend(() => {
      if (stage.intent !== undefined) {
        return record.appendResult({ kind: stage.kind, op: stage.request.op }, stage.intent.action.id, {
          phase: "result", terminal: outcome.terminal, effect: stage.request.effect,
          ...evidence,
          ...outcomeFields(outcome, (value) => projectValue(stage.kind, value)),
          ...(stage.request.toolObservation === undefined ? {} : { callId: stage.request.toolObservation.callId }),
          ...(!project || stage.request.toolResult === undefined ? {} : { toolResult: stage.request.toolResult(outcome) }),
        }, outcome.terminal === "executed" && outcome.failure === undefined ? stage.request.revertData?.() : undefined).pipe(Effect.as(outcome));
      }
      return Effect.succeed(outcome);
    });
  }

  function finishBody<R>(stage: Stage<R>, body: BodyExit): Effect.Effect<ExecutionResult, ExecutionError> {
    return Effect.suspend(() => {
      const { exit } = body;
      if (body.rawPending) {
        return appendOutcome(stage, { terminal: "outcome_unknown", reason: "raw_body_unsettled_after_grace" }, {
          evidence: Exit.isFailure(exit) ? causeEvidence(exit.cause) : { failures: [], defects: [], interrupted: false },
        });
      }
      if (Exit.isFailure(exit)) {
        const commitFailure = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error).find((error) => error._tag === "CommitFailed");
        if (commitFailure !== undefined) return Effect.fail(commitFailure);
        const failure = Failure.of(exit.cause, stage.request.op);
        return appendOutcome(stage, failedOutcome(exit.cause, failure), { evidence: causeEvidence(exit.cause) });
      }
      return complete(stage, exit.value).pipe(
        Effect.catchCause((cause) => completionFailure(stage, exit.value, cause)),
      );
    }).pipe(Effect.map((outcome) => {
      record.publishToolTerminal(stage.request, body.startedAt, terminalStatus(outcome));
      return outcome;
    }));
  }

  function completionFailure<R>(stage: Stage<R>, value: PlainValue, cause: Cause.Cause<ExecutionError>) {
    const failures = cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
    if (failures.some((error) => error._tag === "CommitFailed")) return Effect.failCause(cause);
    const terminalExists = stage.intent !== undefined && options.ledger.resultFor?.(stage.intent.action.id) !== undefined;
    if (terminalExists) return Effect.failCause(cause);
    const failure = Failure.of(cause, `${stage.request.op}.completion`);
    return appendOutcome(stage, { terminal: "executed", value, failure }, {
      disposition: "irreversible", evidence: causeEvidence(cause),
    }, false);
  }

  function complete<R>(stage: Stage<R>, raw: PlainValue): Effect.Effect<ExecutionResult, ExecutionError> {
    return Effect.gen(function* () {
      const value = clonePlainValue(raw);
      const outcome = consulted(stage.request.kind, "post")
        ? yield* decide(stage.request, "post", { intent: stage.request.intent, effect: stage.request.effect, result: value }).pipe(
            Effect.flatMap((post) => settlePost(stage.request, post, value)))
        : { terminal: "executed" as const, value };
      if (stage.request.boundary === true && outcome.terminal === "executed" && stage.intent !== undefined) {
        yield* record.commit({
          id: `${stage.intent.action.id}:boundary`, parentId: stage.intent.action.id,
          sessionId: options.identity.sessionId, kind: stage.kind,
          intent: { encodingVersion: 1, value: { phase: "boundary", op: stage.request.op } },
          effect: { encodingVersion: 1, value: { phase: "boundary", result: projectValue(stage.kind, outcome.value), resultHash: canonicalDigest(outcome.value) } },
          ts: options.clock(), irreversible: true,
        });
      }
      return yield* appendOutcome(stage, outcome);
    });
  }

  function finishStage<R>(stage: Stage<R>, decision: "approve" | "refuse" | "timeout" | undefined, body: BodyExit | undefined) {
    if (stage.pre.verdict !== "deny" && decision === "approve")
      return body === undefined ? Effect.die("missing action fiber exit") : finishBody(stage, body);
    return appendOutcome(stage, {
      terminal: "blocked_pre",
      reason: stage.pre.verdict === "deny" ? stage.pre.reason ?? "denied"
        : decision === "timeout" ? "approval_timeout" : "approval_refused",
    });
  }

  function runSingle<R>(single: Stage<R>, signal: AbortSignal, controller: AbortController, restore: Restore, scope: Scope.Scope) {
    return approval(single, signal).pipe(Effect.flatMap((decision) => {
      if (single.pre.verdict === "deny" || decision !== "approve")
        return finishStage(single, decision, undefined).pipe(Effect.map((result) => [result]));
      let body: BodyExit | undefined;
      return Effect.forkIn(executeBody(single, signal, false, (result: BodyExit) => { body = result; }), scope).pipe(
        Effect.flatMap((fiber) => Effect.exit(restore(Fiber.await(fiber))).pipe(
          Effect.flatMap((awaited) => Exit.isFailure(awaited)
            ? Effect.sync(() => controller.abort()).pipe(Effect.flatMap(() => Fiber.await(fiber)))
            : Effect.void),
          Effect.flatMap(() => finishStage(single, decision, body)),
          Effect.map((result) => [result]),
        )),
      );
    }));
  }

  function runStages<R>(stages: readonly Stage<R>[], signal: AbortSignal, controller: AbortController, guarded: boolean, restore: Restore, scope: Scope.Scope) {
    return Effect.gen(function* () {
      const decisions = yield* Effect.forEach(stages, (stage) => restore(approval(stage, signal)), { concurrency: BOUNDED_CONCURRENCY });
      const exits = new Map<number, BodyExit>();
      const group: Fiber.Fiber<void, never>[] = [];
      const join = Effect.suspend(() => Effect.gen(function* () {
        const waiting = Effect.forEach(group, Fiber.await, { discard: true });
        const exit = yield* Effect.exit(restore(waiting));
        if (Exit.isFailure(exit)) {
          controller.abort();
          yield* waiting;
        }
      }));
      const shouldExecute = (stage: Stage<R>, index: number) => stage.pre.verdict !== "deny" && decisions[index] === "approve";
      for (const [index, stage] of stages.entries()) {
        if (!shouldExecute(stage, index)) continue;
        if (stage.item.sequential) { yield* join; group.length = 0; }
        const work = executeBody(stage, signal, guarded, (result) => { exits.set(index, result); });
        const fiber = yield* Effect.forkIn(work, scope);
        group.push(fiber);
        if (stage.item.sequential) { yield* join; group.length = 0; }
      }
      yield* join;
      return yield* Effect.forEach(stages, (stage, index) => finishStage(stage, decisions[index], exits.get(index)));
    });
  }

  function runBatch<R>(items: readonly ExecutionBatchItem<R>[], control: WaveControl): Effect.Effect<readonly ExecutionResult[], ExecutionError, Exclude<R, RawToolSlots | Scope.Scope>> {
    return Effect.uninterruptibleMask((restore) => {
      const controller = new AbortController();
      const signal = combinedSignal(controller.signal, control.signal, options.signal);
      return Effect.scopedWith((scope) => stageAll(items).pipe(Effect.flatMap((stages: Stage<R>[]) => {
        const guarded = stages.some((stage) => needsApproval(stage) || stage.request.originalAction !== undefined);
        const single = stages.length === 1 ? stages[0] : undefined;
        return single !== undefined && !guarded
          ? runSingle(single, signal, controller, restore, scope)
          : runStages(stages, signal, controller, guarded, restore, scope);
      })));
    });
  }

  function run<T extends PlainValue, R>(request: ExecutionRequest,
    body: (intent: LedgerAction.Receipt, admittedInput: PlainValue) => Effect.Effect<T, ExecutionError, R>) {
    return runBatch([{ request, body }], { signal: options.signal ?? new AbortController().signal }).pipe(
      Effect.flatMap((results) => {
        const result = results[0];
        if (result === undefined) return Effect.die("missing execution outcome");
        return result.terminal === "executed" && result.failure !== undefined
          ? Effect.fail(result.failure) : Effect.succeed(result);
      }),
    );
  }

  function runExisting<T extends PlainValue, R>(request: ExecutionRequest, body: (pre: PolicyEvaluation) => Effect.Effect<T, ExecutionError, R>) {
    return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const pre = yield* decide(request, "pre", request.intent);
      // #1256 r3 H-3: transform/obligation are allow-shaped effective verdicts
      // (a prompt.pre rewrite must flow, not block); only deny and
      // require_approval refuse here.
      if (pre.verdict === "deny" || pre.verdict === "require_approval")
        return { terminal: "blocked_pre", reason: pre.reason ?? "denied" } as const;
      const exit = yield* Effect.exit(restore(Effect.scoped(body(pre))));
      if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
      const value = clonePlainValue(exit.value);
      if (!consulted(request.kind, "post")) return { terminal: "executed", value } as const;
      const post = yield* decide(request, "post", { intent: request.intent, effect: request.effect, result: value });
      return yield* settlePost(request, post, value);
    }));
  }

  const runAttempts = createAttemptRunner(options, record,
    (request, parent) => decide({ kind: "llm", ...request }, "pre", request.intent, parent.action.id),
    (request, intent, pre) => awaitApproval({
      id: intent.action.id, sessionId: options.identity.sessionId, turnId,
      toolsHash: options.identity.toolsHash, toolsGeneration: options.identity.toolsGeneration,
      callId: intent.action.id, inputHash: canonicalDigest(request.intent), generation: pre.generation,
      revision: pre.receipt.revision, policyDecisionId: pre.receipt.action.id, intent: request.intent,
    }, options.signal ?? new AbortController().signal, { effect: request.effect }));
  const judgeStop = createStopJudge(options,
    (op, value) => decide({ kind: "turn", op, intent: value, effect: {} }, "post", value), record.commit);
  return { run, runBatch, runExisting, runAttempts, judgeStop, approvals, recover: recovery.recover };
  });
}

function needsApproval(stage: { readonly pre: Pick<PolicyEvaluation, "verdict">; readonly request: ExecutionRequest }) {
  return stage.pre.verdict === "require_approval" || stage.request.approval?.required === true;
}
/** Re-admission is bound to the original persisted pre-decision identity. */
function recordedDecision(ledger: ExecutorOptions["ledger"], original: LedgerAction.Node, decisionId: PlainValue | undefined) {
  const action = typeof decisionId === "string" ? ledger.actionById?.(decisionId) : undefined;
  return action?.sessionId === original.sessionId && action.kind === "policy.decision" && action.ordinal < original.ordinal ? action : undefined;
}
/** The committed policy.decision intent: the public evaluation plus the gate's replayable record (#1251 r3). */
function decisionIntentValue(request: ExecutionRequest, phase: "pre" | "post", decision: PolicyEvaluation): PlainValue {
  return {
    hook: `${request.kind}.${phase}`, op: request.op, generation: decision.generation,
    matchedRuleIds: [...decision.matchedRuleIds], verdict: decision.verdict, inputHash: decision.inputHash,
    transforms: decision.transforms.map((transform) => ({ ...transform })),
    ...(decision.ref === undefined ? {} : { ref: decision.ref }),
    // The gate's replayable decision (#1251 r3): recorded handler
    // responses, rewrite output, facts — re-admission replays this.
    ...(decision.gate === undefined ? {} : { gate: decision.gate }),
  };
}

/** Re-admits a recovered request against its persisted pre-decision; any mismatch is a stale approval. */
function recoverAdmission(
  options: { readonly ledger: ExecutorOptions["ledger"]; readonly identity: ExecutorOptions["identity"]; readonly policy: CompiledPolicySnapshot },
  request: ExecutionRequest,
  original: LedgerAction.Node,
): Admitted {
  const intent = object(original.intent.value);
  const inputHash = canonicalDigest({ kind: request.kind, phase: "pre", op: request.op, role: options.identity.role,
    sessionId: options.identity.sessionId, ...(request.message === undefined ? {} : { message: request.message }), value: request.intent });
  const action = recordedDecision(options.ledger, original, intent.policyDecisionId);
  if (action === undefined || intent.value === undefined) throw new ExecutionApprovalError({ code: "stale_approval" });
  const { gate, ...decisionIntent } = object(action.intent.value);
  const verdict = recordedVerdict(decisionIntent.verdict);
  const recorded = SessionHistory.PolicyDecision.parse({ ...decisionIntent,
    revision: action.ordinal, actionId: action.id, subjectActionId: action.parentId, turnId: options.identity.turnId ?? null,
    reason: object(action.effect.value).reason ?? null,
  });
  if (recorded.inputHash !== inputHash || recorded.generation !== options.policy.generation ||
      recorded.hook !== `${request.kind}.pre` || recorded.op !== request.op)
    throw new ExecutionApprovalError({ code: "stale_approval" });
  // Re-admission replays the committed gate decision (#1251 r3): the
  // recorded responses are the evidence, so no handler ever re-runs. Byte
  // admission exists ONLY for truly absent pre-contract evidence; a present
  // record that no longer parses is a corrupt decision and refuses (r4).
  const value = gate === undefined ? intent.value : replayRecordedValue(options.policy, request, options.identity, parseGateEvidence(gate));
  return { generation: recorded.generation, verdict, transforms: recorded.transforms,
    value, ...(recorded.reason === null ? {} : { reason: recorded.reason }),
    receipt: { action, revision: action.ordinal } };
}

/** Present evidence must be a well-formed decision; a malformed record refuses instead of degrading to byte admission. */
function parseGateEvidence(gate: PlainValue): GateDecision {
  const evidence = GateDecision.safeParse(gate);
  if (!evidence.success) throw new ExecutionApprovalError({ code: "stale_approval" });
  return evidence.data;
}

/** Replays the committed gate decision through the pinned snapshot; anything but a verbatim replay is a stale approval. */
function replayRecordedValue(
  policy: CompiledPolicySnapshot,
  request: ExecutionRequest,
  identity: ExecutorOptions["identity"],
  recorded: GateDecision,
): PlainValue {
  const replayed = policy.evaluate({
    kind: request.kind, phase: "pre", op: request.op, role: identity.role, sessionId: identity.sessionId,
    ...(request.message === undefined ? {} : { message: request.message }), value: request.intent, recorded,
  });
  if (replayed.replayed !== true) throw new ExecutionApprovalError({ code: "stale_approval" });
  return replayed.value;
}

function recordedVerdict(verdict: PlainValue | undefined): PolicyEvaluation["verdict"] {
  // "consult" is row vocabulary, never an evaluation outcome: a consulted row
  // records the folded allow/deny/require_approval, so it is excluded here.
  const parsed = RowVerdictType.exclude(["consult"]).safeParse(verdict);
  if (!parsed.success) throw new ExecutionApprovalError({ code: "stale_approval" });
  return parsed.data;
}
function assertFresh(request: ExecutionRequest, captured: ReturnType<SessionHandleStore.SessionKernel["requestById"]>): void {
  if (captured !== undefined && request.domainRevisions !== undefined &&
      canonicalDigest({ ...request.domainRevisions() }) !== canonicalDigest(captured.domainRevisions))
    throw new ExecutionApprovalError({ code: "stale_approval" });
}
/** Body results cross the durable boundary as canonical JSON: non-finite numbers become null. */
export function clonePlainValue(value: PlainValue): PlainValue {
  return JSON.parse(JSON.stringify(value)) as PlainValue;
}

export function immutableInput(value: PlainValue): PlainValue {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutableInput(child);
    Object.freeze(value);
  }
  return value;
}
function settlePost(request: ExecutionRequest, post: PolicyEvaluation, value: PlainValue): Effect.Effect<ExecutionResult, ExecutionError> {
  const transformed = post.verdict === "transform" ? object(post.value).result : value;
  if (post.verdict !== "deny" && post.verdict !== "require_approval" && transformed !== undefined)
    return Effect.succeed({ terminal: "executed", value: transformed });
  const outcome = { terminal: "blocked_post", disposition: request.revert === undefined ? "irreversible" : "reverted",
    reason: transformed === undefined ? "invalid_output" : post.reason ?? "denied" } as const;
  return request.revert === undefined ? Effect.succeed(outcome) : Effect.as(Effect.suspend(request.revert), outcome);
}
function terminalStatus(outcome: ExecutionResult): ToolObservationStatus {
  if (outcome.terminal !== "executed" || outcome.failure !== undefined) return "error";
  const status = object(outcome.value).status;
  return status === "success" || status === "timed_out" ? status : "error";
}

export { ExecutionApprovalError } from "../failure";
