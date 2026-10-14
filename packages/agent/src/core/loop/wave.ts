import { Effect, Scope, Context, Exit, Cause, Option, Fiber } from "effect";
import * as Failure from "../ports/failure";
import { thrownAsError } from "../ports/failure";
import { type ExecutionError, type CommitFailed, ExecutionApprovalError, AgentFailure, Interrupted, OutcomeUnknown } from "../ports/failure";
import { type LedgerAction, type PlainValue, type PlainObject, canonicalDigest, listenForAbort } from "@openomni/protocol";
import type { PolicyEvaluation } from "../gate/compile";
import type { WaveControl } from "./tool";
import { BOUNDED_CONCURRENCY } from "../ports/ports";
import { GenerationRawSlots, RawToolSlots, createRawSlots, immutableInput, type Admitted, type Decision, type ExecutionBatchItem, type ExecutionRequest, type ExecutionResult, type ResolvedExecutorOptions } from "./invocation";
import { causeEvidence, clonePlainValue, type createExecutionRecord, object, recoveryClassification, settlePost, type ToolObservationStatus } from "./record";
import { assertFresh, type createExecutionApprovals, recoverAdmission } from "./approval";

const DEFAULT_CLOSE_GRACE_MS = 30_000;

const CORE_KINDS = new Set(["prompt", "turn", "llm", "tool", "compaction", "message"]);

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
  if (outcome.terminal === "executed") return { result: project(outcome.value), resultHash: canonicalDigest(outcome.value) };
  return outcome.terminal === "blocked_post" ? { reason: outcome.reason, disposition: outcome.disposition } : { reason: outcome.reason };
}

function failedOutcome(cause: Cause.Cause<ExecutionError>, failure: ExecutionError): ExecutionResult {
  if (Cause.hasInterrupts(cause) || failure._tag === "Interrupted") return { terminal: "interrupted", reason: "fiber_interrupted" };
  return failure._tag === "OutcomeUnknown"
    ? { terminal: "outcome_unknown", reason: failure.reason }
    : { terminal: "executed", value: null, failure };
}

function needsApproval(stage: { readonly pre: Pick<PolicyEvaluation, "verdict">; readonly request: ExecutionRequest }) {
  return stage.pre.verdict === "require_approval" || stage.request.approval?.required === true;
}

function terminalStatus(outcome: ExecutionResult): ToolObservationStatus {
  if (outcome.terminal !== "executed" || outcome.failure !== undefined) return "error";
  const status = object(outcome.value).status;
  return status === "success" || status === "timed_out" ? status : "error";
}

export function createWave(
  options: ResolvedExecutorOptions,
  record: ReturnType<typeof createExecutionRecord>,
  awaitApproval: ReturnType<typeof createExecutionApprovals>["awaitApproval"],
  decide: (request: ExecutionRequest, phase: "pre" | "post", value: PlainValue, parentId?: string | null) => Effect.Effect<Decision, CommitFailed>,
  consulted: (kind: string, phase: "pre" | "post") => boolean,
  projectValue: (kind: string, value: PlainValue) => PlainValue,
) {
  const turnId = options.identity.turnId ?? options.identity.parentActionId;
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
      catch: (cause) => cause instanceof ExecutionApprovalError ? cause
        : new AgentFailure({ operation: "executor.recover_admission", cause: cause instanceof Error ? cause : thrownAsError(cause).message }),
    });
  }

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
        if (!CORE_KINDS.has(request.kind))
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
        if (!CORE_KINDS.has(request.kind))
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
      const enter = (): Effect.Effect<PlainValue, ExecutionError, R> => assertFresh(stage.request, captured).pipe(Effect.flatMap(() => {
        if (captured !== undefined && options.ledger.validateRequest?.(captured) === false)
          return Effect.fail(new ExecutionApprovalError({ code: "stale_approval" }));
        started();
        const admitted = object(intent.action.intent.value).value;
        if (admitted === undefined) return Effect.die("missing admitted input");
        return stage.item.body(intent, immutableInput(structuredClone(admitted)));
      }));
      return assertFresh(stage.request, captured).pipe(Effect.flatMap(() => {
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
      }));
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
        ? yield* decide(stage.request, "post", { intent: stage.request.intent, effect: stage.request.effect, result: projectValue(stage.kind, value) }).pipe(
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
  return runBatch;
}
