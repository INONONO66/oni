import type { LedgerError } from "../store/errors";
import { Effect, type Scope, Context, Deferred, Exit, Option } from "effect";
import { type ExecutionError, GenerationUnavailable, InvocationClosed } from "../ports/failure";
import type { BusEvent, LedgerAction, LedgerSession, ObservationSink as ObservationPort, PlainValue, SessionTransition, Tool } from "@oni/protocol";
import type { PolicyBinding, PolicyEvaluationInput, PolicyEvaluation } from "../gate/types";
import type { RetryAlarmPort } from "../ports/alarm";
import type { WaveControl, Dispatcher } from "./tool";
import { AsyncLocalStorage } from "node:async_hooks";
import { onAbort, type CapturedGeneration } from "../ports/ports";
import type { ApprovalPolicy } from "../composition/approval-policy";
import type { LlmAttempts } from "./attempts";
import type { ExecutionApprovalRequest, ExecutionApprovals, OwnerApprovalEvidence } from "./approval";

export interface ExecutionLedger {
  commit(action: LedgerAction.Append): Effect.Effect<LedgerAction.Receipt, LedgerError>;
    toolOutputBudgetBytes?(): number;
    putToolOutput?(write: { readonly outputId: string; readonly bytes: Uint8Array; readonly mediaType?: string }): void;
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
  ): Effect.Effect<import("../session/request").RequestDecision, ExecutionError>;
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

export interface ToolObservationIdentity {
  readonly turnId: string;
  readonly callId: string;
  readonly timeoutMs?: number;
}

export type RecoveryClassification =
  | "local_transactional"
  | "endpoint_idempotent"
  | "read_back_reconcilable"
  | "ambiguous_no_replay";

export interface ExecutionRequest {
  readonly kind: string;
  readonly op: string;
  readonly intent: PlainValue;
  readonly effect: PlainValue;
    readonly recovery?: RecoveryClassification;
  readonly message?: PolicyEvaluationInput["message"];
  readonly revert?: () => Effect.Effect<void, ExecutionError>;
    readonly revertData?: () => PlainValue | undefined;
    readonly boundary?: boolean;
  readonly toolObservation?: ToolObservationIdentity;
    readonly toolResult?: (outcome: ExecutionBatchResult) => Tool.Result;
  readonly approval?: {
    readonly required: boolean;
    readonly domainRevisions: Readonly<Record<string, number>>;
    readonly timeoutMs?: number;
  };
  readonly domainRevisions?: () => Readonly<Record<string, number>>;
  readonly originalAction?: LedgerAction.Node;
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
    state: import("./stop").StopState,
    observation: import("./stop").StopObservation,
  ): Effect.Effect<{
    state: import("./stop").StopState;
    verdict: import("./stop").StopVerdict;
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

export interface ExecutorOptions {
    readonly retryAlarm?: RetryAlarmPort;
  readonly signal?: AbortSignal;
  readonly retainEffect?: (effect: Promise<void>) => void;
  readonly closeGraceMs?: number;
  readonly approvalTimeoutMs?: number;
    readonly approvalPolicy: ApprovalPolicy;
  readonly ledger: ExecutionLedger;
  readonly identity: ExecutionIdentity;
  readonly authorizeApproval?: (
    credential: string,
    request: ExecutionApprovalRequest,
  ) => Effect.Effect<OwnerApprovalEvidence, ExecutionError>;
}

export interface ResolvedExecutorOptions extends ExecutorOptions {
  readonly policy: PolicyBinding;
  readonly observations: ObservationPort | BusEvent.Sink;
  readonly clock: () => number;
  readonly entropy: () => string;
    readonly random: () => number;
}

export class RawToolSlots extends Context.Service<
  RawToolSlots,
  ReturnType<typeof createRawSlots>
>()("@oni/agent/RawToolSlots") {}

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
  const awaitSettled: Effect.Effect<void> = Effect.suspend(() => pending.size === 0 ? Effect.void
    : Effect.forEach([...pending.values()], Deferred.await, { discard: true }).pipe(Effect.andThen(awaitSettled)));
  return { open, awaitSettled, pending: () => pending.size };
}

export class GenerationRawSlots extends Context.Service<
  GenerationRawSlots, ReturnType<typeof createRawSlots>
>()("@oni/agent/GenerationRawSlots") {}

const invocationLifetime = Symbol("invocationLifetime");

interface InvocationLifetime {
  readonly source: InvocationFrame;
  readonly failure: () => InvocationClosed | GenerationUnavailable | undefined;
}

export interface InvocationFrame {
  readonly [invocationLifetime]?: InvocationLifetime;
  readonly executor: Executor;
  readonly cell: Dispatcher;
  readonly policy: PolicyBinding;
  readonly generation: CapturedGeneration;
}

export const activeInvocation = new AsyncLocalStorage<{ readonly executor: Executor; readonly captured?: InvocationFrame }>();

export class ExecutorContext extends Context.Service<ExecutorContext, Executor>()("@oni/agent/ExecutorContext") {}

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

export function requireExecutor<T>(value: T | undefined): T {
  if (value === undefined) throw new ExecutorContextError();
  return value;
}

export function currentExecutor(): Executor {
  return requireExecutor(activeInvocation.getStore()?.executor);
}

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

export function forkInvocation(tool: string) {
  const frame = requireOpenInvocation();
  return openInvocation(frame[invocationLifetime]?.source ?? frame, tool);
}

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

export type Decision = PolicyEvaluation & { readonly receipt: LedgerAction.Receipt };

export type Admitted = Pick<Decision, "generation" | "receipt" | "verdict" | "value" | "reason" | "transforms">;

export function immutableInput(value: PlainValue): PlainValue {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutableInput(child);
    Object.freeze(value);
  }
  return value;
}
