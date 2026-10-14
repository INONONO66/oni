import { Effect, Exit, Cause, Option } from "effect";
import { type ExecutionError, PolicyDenied } from "../ports/failure";
import { LedgerAction, type PlainValue, type PlainObject, canonicalDigest } from "@openomni/protocol";
import type { PolicyEvaluation } from "../gate/compile";
import { attemptReason, decide as decideRetry, isInstantFailure, MAX_ATTEMPTS, type Decision as RetryDecision } from "./retry";
import type { RetryReason } from "../ports/reason-codes";
import type { FailureClass } from "../ports/llm";
import type { ResolvedExecutorOptions } from "./invocation";
import { causeEvidence, type RecordPort } from "./record";
import { createLedgerRetryAlarmPort, failureRequiresStop, retryDelay, retryableFailure, terminalFailure } from "./retry";

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
  /**
   * The closed classification of a failed attempt: the port's pure classifier
   * applied to the failure. The loop decides retry, overflow recovery,
   * fallback and caps over this value and never reads the error.
   */
  classify(error: ExecutionError): FailureClass;
  /** Durable attempt evidence (usage, visible-output boundary, credential handle) projected from a settled body. */
  evidence?(value: T): PlainValue;
  onRetry?(decision: {
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly delayMs: number;
    readonly decision: RetryDecision;
    readonly error: ExecutionError;
    readonly reason: RetryReason;
  }): void;
}

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

type Admission = PolicyEvaluation & { readonly receipt: LedgerAction.Receipt };

type Prepared<T extends PlainValue> = Effect.Success<ReturnType<LlmAttempts<T>["prepare"]>>;

function usageProvenance(evidence: PlainValue, failure: ExecutionError | undefined) {
  const record = evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)
    ? evidence : {};
  const origin = failure?._tag === "LlmRunFailure" ? failure.usageProvenance : record.usageProvenance;
  return origin === "reported" || origin === "estimated" ? origin : "unknown";
}

export function createAttemptRunner(
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
              effectHash: canonicalDigest(prepared.request.effect), attempt, maxAttempts: MAX_ATTEMPTS,
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
  function scheduleRetry<T extends PlainValue>(attempts: LlmAttempts<T>, failure: ExecutionError, classified: FailureClass, attempt: number, instantFailures: number, prepared: Prepared<T>, intent: LedgerAction.Receipt) {
    return Effect.gen(function* () {
      if (failureRequiresStop(failure, options.signal) || classified.kind === "aborted") return yield* terminalFailure(failure, attempt, classified);
      const overflow = classified.kind === "overflow";
      const decision = decideRetry(attempt, classified, options.random, instantFailures, prepared.fallbackAvailable);
      if (attempt >= MAX_ATTEMPTS) return yield* terminalFailure(failure, attempt, classified);
      const recover = overflow && (yield* attempts.recoverOverflow?.(failure) ?? Effect.succeed(false));
      if (!recover && (overflow || !decision.retry)) return yield* terminalFailure(failure, attempt, classified);
      const delayMs = retryDelay(recover, decision);
      const reason = recover ? "context_overflow" : attemptReason(classified);
      attempts.onRetry?.({ attempt, maxAttempts: MAX_ATTEMPTS, delayMs, decision, error: failure, reason });
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
              const classified = attempts.classify(failure);
              instantFailures = isInstantFailure(classified, options.clock() - started) ? instantFailures + 1 : 0;
              return scheduleRetry(attempts, failure, classified, attempt, instantFailures, prepared, intent).pipe(
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
