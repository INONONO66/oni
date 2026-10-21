import { Effect, Deferred, Exit } from "effect";
import { type ExecutionError, ExecutionApprovalError } from "../ports/failure";
import { GateDecision, type LedgerAction, type PlainValue, type SessionTransition, canonicalDigest, PlainValueSchema, RowVerdictType, SessionHistory } from "@oni/protocol";
import type { CompiledPolicySnapshot, PolicyEvaluation } from "../gate/compile";
import { onAbort } from "../ports/ports";
import { createApprovalRequest } from "../journal/request-binding";
import type * as SessionHandleStore from "../store/fence";
import type { Admitted, ExecutionRequest, ExecutorOptions, ResolvedExecutorOptions } from "./invocation";
import { object } from "./record";

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

export interface OwnerApprovalEvidence {
  readonly kind: "owner";
  readonly principalId: string;
  readonly evidenceId: string;
}

export interface ExecutionApprovals {
  pending(): readonly ExecutionApprovalRequest[];
  answer(answer: ExecutionApprovalAnswer): Effect.Effect<void, ExecutionError>;
  notify?(request: SessionTransition.Request): void;
}

type ApprovalDecision = "approve" | "refuse" | "timeout";

export function createExecutionApprovals(options: ResolvedExecutorOptions) {
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

function recordedDecision(ledger: ExecutorOptions["ledger"], original: LedgerAction.Node, decisionId: PlainValue | undefined) {
  const action = typeof decisionId === "string" ? ledger.actionById?.(decisionId) : undefined;
  return action?.sessionId === original.sessionId && action.kind === "policy.decision" && action.ordinal < original.ordinal ? action : undefined;
}

export function recoverAdmission(
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
  const value = gate === undefined ? intent.value : replayRecordedValue(options.policy, request, options.identity, parseGateEvidence(gate));
  return { generation: recorded.generation, verdict, transforms: recorded.transforms,
    value, ...(recorded.reason === null ? {} : { reason: recorded.reason }),
    receipt: { action, revision: action.ordinal } };
}

function parseGateEvidence(gate: PlainValue): GateDecision {
  const evidence = GateDecision.safeParse(gate);
  if (!evidence.success) throw new ExecutionApprovalError({ code: "stale_approval" });
  return evidence.data;
}

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
  const parsed = RowVerdictType.exclude(["consult"]).safeParse(verdict);
  if (!parsed.success) throw new ExecutionApprovalError({ code: "stale_approval" });
  return parsed.data;
}

export function assertFresh(
  request: ExecutionRequest,
  captured: ReturnType<SessionHandleStore.SessionKernel["requestById"]>,
): Effect.Effect<void, ExecutionApprovalError> {
  return Effect.suspend(() =>
    captured !== undefined && request.domainRevisions !== undefined &&
      canonicalDigest({ ...request.domainRevisions() }) !== canonicalDigest(captured.domainRevisions)
      ? Effect.fail(new ExecutionApprovalError({ code: "stale_approval" }))
      : Effect.void);
}
