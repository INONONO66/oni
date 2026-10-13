import { parseJson } from "@openomni/protocol";
import { z } from "zod";
import { type ApiFailure, coerceApiError, declaredContextOverflow, errorFacts } from "./error";
import { headerDelay } from "./header-delay";
import type { AttemptFailureReason, FailureClass, FailureFacts, ProviderReason, RetryableProviderReason } from "./port";

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

/**
 * A length stop that produced nothing with the prompt this close to the
 * window is the window, not the output cap: the provider had no room to
 * answer. Named once (#1352).
 */
export const NEAR_WINDOW_RATIO = 0.99;

/** Declared on the typed failure, else the provider's message text. */
export function isContextOverflow(error: Error): boolean {
  const declared = declaredContextOverflow(error);
  if (declared !== undefined) return declared;
  const message = error.message.toLowerCase();
  return OVERFLOW_PATTERNS.some((pattern) => message.includes(pattern));
}

/** Provider-directed delay retained on the terminal typed failure. */
export function retryAfterMs<E>(error: E, now: () => number): number | undefined {
  return headerDelay(coerceApiError(error), now)?.ms;
}

const Named = z.object({ name: z.string(), message: z.string() });

/**
 * The port's pure, exhaustive classification (#1352): the same facts always
 * land in exactly one kind. Order: an abort outranks everything (it is an
 * instruction, not a fault); overflow next, declared on the failure, named
 * in its text, or proven by usage against the window; then the provider
 * vocabulary over the SDK error in the cause chain. Retry delay, fallback,
 * caps and streaks are the loop's decisions over this value.
 */
export function classifyFailure(facts: FailureFacts): FailureClass {
  if (isAborted(facts.error)) return { kind: "aborted" };
  if (isOverflow(facts)) return { kind: "overflow" };
  const api = apiCause(facts.error);
  const providerReason = classify(api);
  const reason = attemptReason(api);
  switch (providerReason) {
    case "billing":
    case "content_policy":
    case "non_retryable":
      return { kind: "terminal", reason, providerReason, status: api?.statusCode };
    default: {
      const header = headerDelay(api, () => facts.now ?? Number.NaN);
      return {
        kind: "retryable",
        reason,
        providerReason,
        afterMs: header?.ms,
        directed: header?.directive,
        instant: api !== undefined && answeredByTransport(api),
      };
    }
  }
}

function isAborted(error: unknown): boolean {
  if (errorFacts(error).aborted === true) return true;
  const named = Named.safeParse(error);
  return named.success && named.data.name === "AbortError";
}

/**
 * Overflow by declaration or text on the error, else by usage: a normal stop
 * whose prompt (input plus cached reads) exceeded the window, or a length
 * stop that produced no output with the prompt at or above the near-window
 * ratio. Missing usage or window never speculates.
 */
function isOverflow(facts: FailureFacts): boolean {
  const error = facts.error;
  if (error instanceof Error && isContextOverflow(error)) return true;
  const { usage, contextWindow } = facts;
  if (usage === undefined || contextWindow === undefined || contextWindow <= 0) return false;
  const prompt = usage.inputTokens + (usage.cacheReadTokens ?? 0);
  if (facts.finishReason === "length") return usage.outputTokens === 0 && prompt >= contextWindow * NEAR_WINDOW_RATIO;
  return (facts.finishReason === "stop" || facts.finishReason === undefined) && prompt > contextWindow;
}

/** Existing placement/agent machine vocabulary, derived beside provider classification. */
function attemptReason(api: ApiFailure | undefined): AttemptFailureReason {
  if (api === undefined) return "transient_error";
  if (api.statusCode === 408) return "timeout";
  return api.isRetryable ? "transient_error" : "validation_error";
}

/** A status code or response headers prove the endpoint answered: HTTP, not transport. */
function answeredByTransport(data: ApiFailure): boolean {
  return data.isRetryable && data.statusCode === undefined && data.responseHeaders === undefined;
}

/** Bound traversal even for cyclic cause chains. */
const MAX_CAUSE_DEPTH = 8;
const Caused = z.object({ cause: z.instanceof(Object) });

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

function classify(error: ApiFailure | undefined): ProviderReason {
  if (error === undefined) return "non_retryable";
  // Billing and moderation outrank the provider's retryable flag.
  return terminalClass(error) ?? retryableClass(error);
}

function terminalClass(data: ApiFailure): ProviderReason | undefined {
  const payloads = [data.message, data.responseBody];
  if (payloads.some(isBillingExhaustion)) return "billing";
  if (payloads.some((payload) => isContentPolicyRefusal(data.statusCode, payload)))
    return "content_policy";
  return data.isRetryable ? undefined : "non_retryable";
}

/**
 * Status is the fallback when the payload has no recognized signal: 429 is a
 * rate limit; 5xx plus the residue the provider marked retryable (408/409,
 * x-should-retry, network failures) share the server_error bucket since no
 * consumer distinguishes them.
 */
function retryableClass(data: ApiFailure): RetryableProviderReason {
  const sniffed = classifyErrorPayload(data.message) ?? classifyErrorPayload(data.responseBody);
  return sniffed ?? (data.statusCode === 429 ? "rate_limit" : "server_error");
}

/**
 * Balance exhaustion must be unambiguous: these signals identify a spent
 * account, unlike a provider's billing service outage or a per-minute quota.
 * The check precedes retryability because no wait restores a spent balance.
 */
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
  // "You exceeded your current quota" and "You exceeded your monthly quota"
  // name an account limit. Do not accept bare "quota exceeded": it can name
  // a short-lived per-minute limit.
  return /exceeded\s+your\s+(?:current|monthly)\s+(?:usage\s+)?quota/.test(haystack);
}

/**
 * Moderation verdicts, as the providers name them. Scoped to 4xx: a 5xx
 * merely MENTIONING a content policy (a docs service outage, a moderation
 * backend that fell over) is a server fault and must keep its retries.
 */
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

function classifyErrorPayload(payload: string | undefined): RetryableProviderReason | undefined {
  const body = parsePayload(payload);
  return body === undefined ? undefined : bodyClass(body);
}

function bodyClass(body: z.infer<typeof Payload>): RetryableProviderReason | undefined {
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
