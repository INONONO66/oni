import { parseJson } from "@openomni/protocol";
import { z } from "zod";
import { type ApiFailure, coerceApiError, declaredContextOverflow } from "../error";
import { headerDelay } from "./delay";

const Payload = z.object({
  type: z.string().catch(""),
  code: z.string().catch(""),
  error: z
    .object({
      type: z.string().catch(""),
      code: z.string().catch(""),
      message: z.string().catch(""),
    })
    .catch({ type: "", code: "", message: "" }),
});

export namespace Retry {
  export const MAX_ATTEMPTS = 3;

  const OVERFLOW_PATTERNS = [
    "context_length_exceeded",
    "context length",
    "context limit",
    "context window",
    "maximum context",
    "prompt is too long",
    "too many tokens",
    "token limit",
    "exceeds the maximum number of tokens",
    "input is too long",
  ] as const;

  export function isContextOverflow(error: Error): boolean {
    const declared = declaredContextOverflow(error);
    if (declared !== undefined) return declared;
    const message = error.message.toLowerCase();
    return OVERFLOW_PATTERNS.some((pattern) => message.includes(pattern));
  }

  export function attemptReason(
    error: Error,
  ): "timeout" | "transient_error" | "validation_error" | "context_overflow" {
    if (isContextOverflow(error)) return "context_overflow";
    return apiReason(apiCause(error));
  }

  function apiReason(
    api: ApiFailure | undefined,
  ): "timeout" | "transient_error" | "validation_error" {
    if (api === undefined) return "transient_error";
    if (api.statusCode === 408) return "timeout";
    return api.isRetryable ? "transient_error" : "validation_error";
  }
  export const RETRY_INITIAL_DELAY = 2000;
  export const RETRY_BACKOFF_FACTOR = 2;
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000;
  export const RETRY_MAX_DELAY = 2_147_483_647;

  /** A server-directed wait above twice the 30s cap fails fast; retry policy is the caller's. */
  export const RETRY_HEADER_DELAY_CAP = 60_000;

  /**
   * A retryable failure with no HTTP status dying under this window signals refused connections,
   * which backoff cannot relieve: a streak retries on the short probe delay then declines.
   */
  export const INSTANT_FAILURE_WINDOW_MS = 2000;
  export const INSTANT_FAILURE_PROBE_DELAY_MS = 250;
  export const INSTANT_FAILURE_STREAK_LIMIT = 3;

  export function isInstantTransportFailure<E>(error: E, elapsedMs: number): boolean {
    if (elapsedMs >= INSTANT_FAILURE_WINDOW_MS) return false;
    const providerError = apiCause(error);
    return providerError !== undefined && answeredByTransport(providerError);
  }

  /** HTTP, not transport. */
  function answeredByTransport(data: ApiFailure): boolean {
    return data.isRetryable && data.statusCode === undefined && data.responseHeaders === undefined;
  }

  export type Reason =
    | "rate_limit"
    | "overloaded"
    | "server_error"
    | "validation_error"
    | "billing"
    | "content_policy"
    | "non_retryable";
  export type RetryableReason = Exclude<Reason, "non_retryable" | "billing" | "content_policy">;

  export type Decision =
    | {
        readonly retry: true;
        readonly reason: RetryableReason;
        readonly delayMs: number;
        /** An inferred ratelimit reset exceeded the cap and was demoted to backoff. */
        readonly retryAfterOverCap?: boolean;
      }
    | { readonly retry: false; readonly reason: Reason; readonly detail?: string };

  /** Terminal classification precedes probes, headers, backoff; `sources` injects clock/jitter. */
  export function decide<E>(
    attempt: number,
    error: E,
    sources: { now: () => number; random: () => number },
    instantFailureStreak = 0,
    fallbackAvailable = false,
  ): Decision {
    return decideFor(attempt, apiCause(error), sources, instantFailureStreak, fallbackAvailable);
  }

  const TERMINAL_DETAIL = {
    billing:
      "the account's quota or billing balance is exhausted — retrying cannot restore it; top up or raise the limit",
    content_policy:
      "the provider refused this request on content policy grounds — the same prompt will be refused again; change what is being asked",
  } as const;

  function decideFor(
    attempt: number,
    providerError: ApiFailure | undefined,
    sources: { now: () => number; random: () => number },
    instantFailureStreak: number,
    fallbackAvailable: boolean,
  ): Decision {
    const reason = classify(providerError);
    switch (reason) {
      case "non_retryable":
        return nonRetryable(providerError, fallbackAvailable);
      case "billing":
      case "content_policy":
        return { retry: false, reason, detail: TERMINAL_DETAIL[reason] };
      default:
        return retryable(attempt, reason, providerError, sources, instantFailureStreak);
    }
  }

  function retryable(
    attempt: number,
    reason: RetryableReason,
    providerError: ApiFailure | undefined,
    sources: { now: () => number; random: () => number },
    instantFailureStreak: number,
  ): Decision {
    return (
      streakDecision(instantFailureStreak, reason) ??
      selectDelay(attempt, reason, headerDelay(providerError, sources.now), sources.random)
    );
  }

  /** Only a 400 with a fallback candidate earns an immediate re-route. */
  function nonRetryable(
    providerError: ApiFailure | undefined,
    fallbackAvailable: boolean,
  ): Decision {
    if (fallbackAvailable && providerError?.statusCode === 400)
      return { retry: true, reason: "validation_error", delayMs: 0 };
    return { retry: false, reason: "non_retryable" };
  }

  function streakDecision(streak: number, reason: RetryableReason): Decision | undefined {
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
    reason: RetryableReason,
    header: ReturnType<typeof headerDelay>,
    random: () => number,
  ): Decision {
    if (header === undefined) return { retry: true, reason, delayMs: backoffDelayMs(attempt, random) };
    if (header.ms <= RETRY_HEADER_DELAY_CAP)
      return { retry: true, reason, delayMs: Math.max(0, header.ms) };
    // Explicit directives fail fast; inferred resets demote to backoff.
    if (header.directive) {
      return {
        retry: false,
        reason,
        detail: `server asked to wait ${header.ms}ms, above the ${RETRY_HEADER_DELAY_CAP}ms cap`,
      };
    }
    return { retry: true, reason, delayMs: backoffDelayMs(attempt, random), retryAfterOverCap: true };
  }

  /** Jitter subtracts at most one quarter of the ladder delay. */
  export const RETRY_JITTER_RATIO = 0.25;

  /** Ladder only: a provider that named a delay gets exactly that delay. */
  function backoffDelayMs(attempt: number, random: () => number): number {
    const ladder = Math.min(
      RETRY_INITIAL_DELAY * RETRY_BACKOFF_FACTOR ** (attempt - 1),
      RETRY_MAX_DELAY_NO_HEADERS,
    );
    return Math.round(ladder * (1 - random() * RETRY_JITTER_RATIO));
  }

  export function retryAfterMs<E>(error: E, now: () => number): number | undefined {
    return headerDelay(coerceApiError(error), now)?.ms;
  }

  /** Bounded for cyclic cause chains. */
  const MAX_CAUSE_DEPTH = 8;
  const Caused = z.object({ cause: z.instanceof(Object) });

  export function classifyFailure<E>(error: E): Reason {
    return classify(apiCause(error));
  }

  function apiCause<E>(error: E): ApiFailure | undefined {
    let current: object | undefined = z.instanceof(Object).safeParse(error).data;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
      const apiError = coerceApiError(current);
      if (apiError !== undefined) return apiError;
      current = nextCause(current);
    }
    return undefined;
  }

  function nextCause(current: object): object | undefined {
    const cause = Caused.safeParse(current).data?.cause;
    return cause === current ? undefined : cause;
  }

  function classify(error: ApiFailure | undefined): Reason {
    if (error === undefined) return "non_retryable";
    // Billing and moderation outrank the provider's retryable flag.
    return terminalClass(error) ?? retryableClass(error);
  }

  function terminalClass(data: ApiFailure): Reason | undefined {
    const payloads = [data.message, data.responseBody];
    if (payloads.some(isBillingExhaustion)) return "billing";
    if (payloads.some((payload) => isContentPolicyRefusal(data.statusCode, payload)))
      return "content_policy";
    return data.isRetryable ? undefined : "non_retryable";
  }

  /**
   * Status is the fallback: 429 is a rate limit; 5xx and the provider-marked retryable residue
   * share server_error since no consumer distinguishes them.
   */
  function retryableClass(data: ApiFailure): RetryableReason {
    const sniffed = classifyErrorPayload(data.message) ?? classifyErrorPayload(data.responseBody);
    return sniffed ?? (data.statusCode === 429 ? "rate_limit" : "server_error");
  }

  /** Only unambiguous spent-account signals, before retryability: no wait restores a balance. */
  const BILLING_PATTERNS = [
    "insufficient_quota",
    "out of budget",
    "monthly usage limit",
    "billing_error",
    "billing required",
    "billing balance",
  ] as const;

  function isBillingExhaustion(payload: string | undefined): boolean {
    if (!payload) return false;
    const haystack = payload.toLowerCase();
    if (BILLING_PATTERNS.some((pattern) => haystack.includes(pattern))) return true;
    // Bare "quota exceeded" can name a per-minute limit, so only the
    // "exceeded your current/monthly quota" forms count as an account limit.
    return /exceeded\s+your\s+(?:current|monthly)\s+(?:usage\s+)?quota/.test(haystack);
  }

  /** Scoped to 4xx: a 5xx mentioning a content policy is a server fault and keeps retries. */
  const CONTENT_POLICY_PATTERNS = [
    "content_policy_violation",
    "content_filter",
    "content policy",
    "safety filter",
    "flagged by our moderation",
    "moderation_blocked",
  ] as const;

  function isContentPolicyRefusal(
    statusCode: number | undefined,
    payload: string | undefined,
  ): boolean {
    if (payload === undefined || !isClientError(statusCode)) return false;
    const haystack = payload.toLowerCase();
    return CONTENT_POLICY_PATTERNS.some((pattern) => haystack.includes(pattern));
  }

  function isClientError(statusCode: number | undefined): boolean {
    return statusCode !== undefined && statusCode >= 400 && statusCode < 500;
  }

  function classifyErrorPayload(payload: string | undefined): RetryableReason | undefined {
    const body = parsePayload(payload);
    return body === undefined ? undefined : bodyClass(body);
  }

  function bodyClass(body: z.infer<typeof Payload>): RetryableReason | undefined {
    if (isRateLimitBody(body)) return "rate_limit";
    if (isOverloadedBody(body)) return "overloaded";
    // A generic error body carries no class of its own — defer to status.
    return isServerErrorBody(body) ? "server_error" : undefined;
  }

  function isOverloadedBody(body: z.infer<typeof Payload>): boolean {
    return body.code.includes("exhausted") || body.code.includes("unavailable");
  }

  function parsePayload(payload: string | undefined): z.infer<typeof Payload> | undefined {
    return payload ? parseJson(Payload, payload) : undefined;
  }

  function isRateLimitBody(body: z.infer<typeof Payload>): boolean {
    if (body.type !== "error") return false;
    const { type, code } = body.error;
    return (
      type === "too_many_requests" || type.includes("rate_limit") || code.includes("rate_limit")
    );
  }

  function isServerErrorBody(body: z.infer<typeof Payload>): boolean {
    return (
      body.error.message.includes("no_kv_space") ||
      (body.type === "error" && body.error.type === "server_error")
    );
  }
}
