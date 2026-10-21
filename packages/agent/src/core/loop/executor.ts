import { Effect, Exit, Clock } from "effect";
import { type ExecutionError, type CommitFailed, AgentFailure } from "../ports/failure";
import { type LedgerAction, type PlainValue, canonicalDigest } from "@oni/protocol";
import type { PolicyEvaluation } from "../gate/compile";
import { DEFAULT_TOOL_OUTPUT_BUDGET_BYTES, projectResultValue } from "../ports/tool-output";
import { Entropy, ObservationSink, SessionLayer, type ProcessServices } from "../ports/ports";
import { executionPoint } from "../gate/points";
import type { Decision, DurableExecutor, ExecutionRequest, ExecutorOptions } from "./invocation";
import { clonePlainValue, createExecutionRecord, createExecutionRecovery, settlePost } from "./record";
import { createExecutionApprovals } from "./approval";
import { createWave } from "./wave";
import { createAttemptRunner } from "./attempts";
import { createStopJudge } from "./stop";

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
  const turnId = options.identity.turnId ?? options.identity.parentActionId;
    const projectValue = (kind: string, value: PlainValue): PlainValue => {
    const put = options.ledger.putToolOutput;
    if (kind !== "tool" || put === undefined) return value;
    return projectResultValue(value, {
      budgetBytes: options.ledger.toolOutputBudgetBytes?.() ?? DEFAULT_TOOL_OUTPUT_BUDGET_BYTES,
      put,
    });
  };

    function consulted(kind: string, phase: "pre" | "post"): boolean {
    return executionPoint(kind, phase, options.policy.pointTable) !== undefined;
  }
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

  const runBatch = createWave(options, record, awaitApproval, decide, consulted, projectValue);

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
      if (pre.verdict === "deny" || pre.verdict === "require_approval")
        return { terminal: "blocked_pre", reason: pre.reason ?? "denied" } as const;
      const exit = yield* Effect.exit(restore(Effect.scoped(body(pre))));
      if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
      const value = clonePlainValue(exit.value);
      if (!consulted(request.kind, "post")) return { terminal: "executed", value } as const;
      const post = yield* decide(request, "post", { intent: request.intent, effect: request.effect, result: projectValue(request.kind, value) });
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

function decisionIntentValue(request: ExecutionRequest, phase: "pre" | "post", decision: PolicyEvaluation): PlainValue {
  return {
    hook: `${request.kind}.${phase}`, op: request.op, generation: decision.generation,
    matchedRuleIds: [...decision.matchedRuleIds], verdict: decision.verdict, inputHash: decision.inputHash,
    transforms: decision.transforms.map((transform) => ({ ...transform })),
    ...(decision.ref === undefined ? {} : { ref: decision.ref }),
    ...(decision.gate === undefined ? {} : { gate: decision.gate }),
  };
}

export { ExecutionApprovalError } from "../ports/failure";
export { type ExecutionLedger, type ExecutionRequest, type ExecutionResult, type ExecutionBatchItem, type ExecutionBatchResult, type Executor, type DurableExecutor, type ExecutorOptions, type ResolvedExecutorOptions, RawToolSlots, createRawSlots, GenerationRawSlots, type InvocationFrame, activeInvocation, ExecutorContext, executorContext, ExecutorContextError, requireExecutor, currentExecutor, withExecutor, currentInvocation, requireOpenInvocation, forkInvocation, openInvocation, withInvocation, immutableInput } from "./invocation";
export type { LlmAttempts } from "./attempts";
export type { ExecutionApprovalRequest, ExecutionApprovals } from "./approval";
export { failureEvidence } from "./record";
export { createLedgerRetryAlarmPort } from "./retry";
