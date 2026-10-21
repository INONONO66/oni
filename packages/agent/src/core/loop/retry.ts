import { LlmCall, Operational, type BusEvent, LedgerAction } from "@oni/protocol";

import { z } from "zod";

import { type FailureClass, isLlmRunFailure, type ProviderReason, type RetryableProviderReason } from "../ports/llm";

import { RetryReason } from "../ports/reason-codes";

import { Effect, Cause, Option } from "effect";

import { type ExecutionError, CommitFailed } from "../ports/failure";

import { type RetryAlarmPort, type RetryAlarmDeps, createRetryAlarmPort } from "../ports/alarm";

import type { ExecutionLedger } from "./invocation";



/** The name is the identity `isAbort` checks, never the message, which other errors may share. */
export function abortError(message = "aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** Decided by signal state or typed identity, never substrings; an abort promises no retry. */
export function isAbort(error: Error, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    error.name === "AbortError" ||
    (isLlmRunFailure(error) && error.aborted)
  );
}

/** A host needs these classified facts to explain a failed turn without matching error text. */
const AgentFailureFacts = z.object({
  reason: z.enum([...RetryReason.options, "aborted"]),
  attempt: z.number(),
  maxAttempts: z.number(),
  llm: z.literal(true),
});

type AgentFailureFacts = z.infer<typeof AgentFailureFacts>;

/** Carried on the error itself (wrapping changes the identity catchers read); symbol = hidden. */
const FAILURE_FACTS = Symbol.for("oni.agent.failureFacts");

/** Stamps the decided facts onto the error the run is raising. */
function attachFailureFacts(error: object, facts: AgentFailureFacts): void {
  Object.defineProperty(error, FAILURE_FACTS, {
    value: facts,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/** Undefined when the error did not come from a run or died before a decision; never invent an attempt count. */
export function failureFacts<T>(error: T): AgentFailureFacts | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const parsed = AgentFailureFacts.safeParse(Reflect.get(error, FAILURE_FACTS));
  return parsed.success ? parsed.data : undefined;
}

// Attempt policy: the loop owns caps and delays; the port only classifies.

export const MAX_ATTEMPTS = 3;

export const RETRY_INITIAL_DELAY = 2000;

export const RETRY_BACKOFF_FACTOR = 2;

export const RETRY_MAX_DELAY_NO_HEADERS = 30_000;

/** Server-directed waits above this cap fail fast instead of stalling a run mid-flight. */
export const RETRY_HEADER_DELAY_CAP = 60_000;

/** A status-less retryable failure under this window is a refused connection: probe briefly, then decline. */
export const INSTANT_FAILURE_WINDOW_MS = 2000;

export const INSTANT_FAILURE_PROBE_DELAY_MS = 250;

export const INSTANT_FAILURE_STREAK_LIMIT = 3;

/** Jitter subtracts at most one quarter of the ladder delay. */
export const RETRY_JITTER_RATIO = 0.25;

/** The classified failure answered by transport, inside the instant window: one more fast failure on the streak. */
export function isInstantFailure(failure: FailureClass, elapsedMs: number): boolean {
  return elapsedMs < INSTANT_FAILURE_WINDOW_MS && failure.kind === "retryable" && failure.instant;
}

export type Decision =
  | {
      readonly retry: true;
      readonly reason: RetryableProviderReason;
      readonly delayMs: number;
      /** An inferred ratelimit reset exceeded the cap and was demoted to backoff. */
      readonly retryAfterOverCap?: boolean;
    }
  | { readonly retry: false; readonly reason: ProviderReason; readonly detail?: string };

/** The recorded attempt reason of a classified failure (`aborted` is the loop's own verdict, never a reason). */
export function attemptReason(failure: FailureClass): Extract<RetryReason, "timeout" | "transient_error" | "validation_error" | "context_overflow"> {
  switch (failure.kind) {
    case "overflow":
      return "context_overflow";
    case "retryable":
    case "terminal":
      return failure.reason;
    case "aborted":
      return "transient_error";
  }
}

/** The retry decision over a classified failure; `random` injects the jitter draw. Abort and overflow never retry here. */
export function decide(
  attempt: number,
  failure: FailureClass,
  random: () => number,
  instantFailureStreak = 0,
  fallbackAvailable = false,
): Decision {
  switch (failure.kind) {
    case "aborted":
    case "overflow":
      return { retry: false, reason: "non_retryable" };
    case "terminal":
      return terminal(failure, fallbackAvailable);
    case "retryable":
      return streakDecision(instantFailureStreak, failure.providerReason) ??
        selectDelay(attempt, failure, random);
  }
}

const TERMINAL_DETAIL = {
  billing:
    "the account's quota or billing balance is exhausted — retrying cannot restore it; top up or raise the limit",
  content_policy:
    "the provider refused this request on content policy grounds — the same prompt will be refused again; change what is being asked",
} as const;

/** A 400 with a fallback candidate is worth one immediate re-route; nothing else is. */
function terminal(failure: Extract<FailureClass, { kind: "terminal" }>, fallbackAvailable: boolean): Decision {
  const reason = failure.providerReason;
  if (reason === "billing" || reason === "content_policy")
    return { retry: false, reason, detail: TERMINAL_DETAIL[reason] };
  if (reason === "non_retryable") {
    if (fallbackAvailable && failure.status === 400)
      return { retry: true, reason: "validation_error", delayMs: 0 };
    return { retry: false, reason };
  }
  return { retry: false, reason, ...(failure.detail === undefined ? {} : { detail: failure.detail }) };
}

function streakDecision(streak: number, reason: RetryableProviderReason): Decision | undefined {
  if (streak >= INSTANT_FAILURE_STREAK_LIMIT) {
    return {
      retry: false,
      reason,
      detail: `${streak} consecutive transport failures under ${INSTANT_FAILURE_WINDOW_MS}ms — the endpoint is refusing connections, retrying cannot help`,
    };
  }
  return streak > 0
    ? { retry: true, reason, delayMs: INSTANT_FAILURE_PROBE_DELAY_MS }
    : undefined;
}

function selectDelay(
  attempt: number,
  failure: Extract<FailureClass, { kind: "retryable" }>,
  random: () => number,
): Decision {
  const reason = failure.providerReason;
  if (failure.afterMs === undefined) return { retry: true, reason, delayMs: backoffDelayMs(attempt, random) };
  if (failure.afterMs <= RETRY_HEADER_DELAY_CAP)
    return { retry: true, reason, delayMs: Math.max(0, failure.afterMs) };
  // Explicit directives fail fast; inferred resets demote to backoff.
  if (failure.directed) {
    return {
      retry: false,
      reason,
      detail: `server asked to wait ${failure.afterMs}ms, above the ${RETRY_HEADER_DELAY_CAP}ms cap`,
    };
  }
  return { retry: true, reason, delayMs: backoffDelayMs(attempt, random), retryAfterOverCap: true };
}

/** Jitter applies to the ladder only; a provider that named a delay gets exactly that delay. */
function backoffDelayMs(attempt: number, random: () => number): number {
  const ladder = Math.min(
    RETRY_INITIAL_DELAY * RETRY_BACKOFF_FACTOR ** (attempt - 1),
    RETRY_MAX_DELAY_NO_HEADERS,
  );
  return Math.round(ladder * (1 - random() * RETRY_JITTER_RATIO));
}

/** Provider retry facts are emitted only after the executor decides to schedule another attempt. */
export function observeRetry(
  events: BusEvent.Sink,
  input: {
    readonly traceId: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly provider: string;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly decision: Extract<Decision, { retry: true }>;
    /** Wall-clock source for the emitted fact timestamps. */
    readonly now: () => number;
  },
): void {
  const { decision } = input;
  events.publish(LlmCall.Events.RetryDecided, {
    traceId: input.traceId,
    sessionId: input.sessionId,
    runId: input.runId,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    reason: decision.reason,
    backoffMs: decision.delayMs,
    time: input.now(),
  });
  if (decision.reason === "rate_limit")
    events.publish(LlmCall.Events.RateLimited, {
      traceId: input.traceId,
      sessionId: input.sessionId,
      runId: input.runId,
      provider: input.provider,
      retryAfterMs: decision.delayMs,
      time: input.now(),
    });
  if (decision.retryAfterOverCap)
    events.publish(Operational.Events.Warn, {
      traceId: input.traceId,
      sessionId: input.sessionId,
      component: "llm.retry",
      time: input.now(),
      msg: "ratelimit reset above cap; demoted to backoff",
      context: { backoffMs: decision.delayMs },
    });
}

export function terminalFailure(failure: ExecutionError, attempt: number, classified: FailureClass | undefined) {
  if (failure._tag === "LlmRunFailure") attachFailureFacts(failure, {
    reason: failure.aborted || classified === undefined || classified.kind === "aborted" ? "aborted" : attemptReason(classified),
    attempt, maxAttempts: MAX_ATTEMPTS, llm: true,
  });
  return Effect.fail(failure);
}

export function retryableFailure(cause: Cause.Cause<ExecutionError>) {
  const error = Cause.findErrorOption(cause);
  return Cause.hasInterrupts(cause) || Cause.hasDies(cause) || Option.isNone(error)
    ? Effect.failCause(cause) : Effect.succeed(error.value);
}

export function failureRequiresStop(failure: ExecutionError, signal: AbortSignal | undefined): boolean {
  if (failure._tag === "CommitFailed" || signal?.aborted === true) return true;
  return failure._tag === "LlmRunFailure" && (failure.aborted || failure.visibleOutput);
}

export function retryDelay(recover: boolean, decision: Decision): number {
  return !recover && decision.retry ? decision.delayMs : 0;
}

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
