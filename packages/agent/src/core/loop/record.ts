import { Effect, Cause } from "effect";
import { renderBodyCause } from "../ports/failure";
import { type ExecutionError, CommitFailed } from "../ports/failure";
import { type BusEvent, type LedgerAction, type ObservationSink as ObservationPort, type PlainValue, Tool, type PlainObject, L0Observation, canonicalDigest } from "@oni/protocol";
import type { PolicyEvaluation } from "../gate/compile";
import type { ExecutionRequest, ExecutionResult, ExecutorOptions, RecoveryClassification, ResolvedExecutorOptions, ToolObservationIdentity } from "./invocation";

export function failureEvidence(error: ExecutionError): PlainObject {
  switch (error._tag) {
    case "LlmRunFailure": {
      // Only the provider SDK error names itself; a transport or typed failure keeps `null`.
      const providerErrorName = error.providerErrorName ?? null;
      return {
        tag: error._tag,
        message: error.message,
        providerErrorName,
        retryAfterMs: error.retryAfterMs ?? null,
        usage: error.usage,
        aborted: error.aborted,
        contextOverflow: error.contextOverflow,
        visibleOutput: error.visibleOutput,
        cause: error.cause === undefined ? null
          : providerErrorName !== null && typeof error.cause !== "string" ? error.cause.message
          : renderBodyCause(error.cause),
      };
    }
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

export function causeEvidence(cause: Cause.Cause<ExecutionError>): PlainObject {
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

export type ToolObservationStatus = "success" | "error" | "timed_out";

interface ActionSubject {
  readonly kind: LedgerAction.Kind;
  readonly op: string;
}

export function createExecutionRecord(
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

export type RecordPort = ReturnType<typeof createExecutionRecord>;

type RecoveryRecordPort = Pick<ReturnType<typeof createExecutionRecord>, "appendResult">;

type Proof = "absent" | "applied" | "indeterminate";

interface RecoveryVerdict {
  readonly terminal: "interrupted" | "outcome_unknown";
  readonly classification: RecoveryClassification;
  readonly proof: Proof;
  readonly proofReceipt: { readonly id: string; readonly digest: string } | null;
}

export function recoveryClassification(
  request: Pick<ExecutionRequest, "kind" | "recovery">,
): RecoveryClassification {
  if (request.recovery !== undefined) return request.recovery;
  return request.kind === "compaction" || request.kind === "message"
    ? "local_transactional"
    : "ambiguous_no_replay";
}

export function object(value: PlainValue | undefined): PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const classifications: readonly RecoveryClassification[] = [
  "local_transactional",
  "endpoint_idempotent",
  "read_back_reconcilable",
  "ambiguous_no_replay",
];

function recordedClassification(value: PlainValue | undefined): RecoveryClassification | undefined {
  return classifications.find((classification) => classification === value);
}

function localAbsent(receipt: LedgerAction.Node): RecoveryVerdict {
  return {
    terminal: "interrupted",
    classification: "local_transactional",
    proof: "absent",
    proofReceipt: { id: receipt.id, digest: canonicalDigest(receipt.effect.value) },
  };
}

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

export function createExecutionRecovery(options: ExecutorOptions, record: RecoveryRecordPort) {
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

    function boundaryEvidence(intentId: string): LedgerAction.Node | undefined {
    const action = options.ledger.actionById?.(`${intentId}:boundary`);
    return action !== undefined && object(action.effect.value).phase === "boundary"
      ? action
      : undefined;
  }

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

export function clonePlainValue(value: PlainValue): PlainValue {
  return normalizePlainValue(structuredClone(value));
}

function normalizePlainValue(value: PlainValue): PlainValue {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(normalizePlainValue);
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, PlainValue> = {};
    for (const [key, entry] of Object.entries(value)) normalized[key] = normalizePlainValue(entry);
    return normalized;
  }
  return value;
}

export function settlePost(request: ExecutionRequest, post: PolicyEvaluation, value: PlainValue): Effect.Effect<ExecutionResult, ExecutionError> {
  const transformed = post.verdict === "transform" ? object(post.value).result : value;
  if (post.verdict !== "deny" && post.verdict !== "require_approval" && transformed !== undefined)
    return Effect.succeed({ terminal: "executed", value: transformed });
  const outcome = { terminal: "blocked_post", disposition: request.revert === undefined ? "irreversible" : "reverted",
    reason: transformed === undefined ? "invalid_output" : post.reason ?? "denied" } as const;
  return request.revert === undefined ? Effect.succeed(outcome) : Effect.as(Effect.suspend(request.revert), outcome);
}
