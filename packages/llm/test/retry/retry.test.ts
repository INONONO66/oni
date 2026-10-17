import { describe, expect, test } from "bun:test";
import type { FailureClass, ProviderReason } from "../../src/port";

import { apiError, classifyError, FIXED_RETRY_NOW, rateLimitError, type SdkErrorInput } from "../helpers/retry";

function retryableError(headers?: Record<string, string>) {
  return apiError({
    message: "Rate limited",
    isRetryable: true,
    ...(headers && { responseHeaders: headers }),
  });
}

/** The server-directed wait the classifier read off the headers; absent means the loop's own ladder applies. */
function afterMsOf<E>(error: E): number | undefined {
  const classified = classifyError(error);
  if (classified.kind !== "retryable") throw new Error(`expected a retryable classification, got ${classified.kind}`);
  return classified.afterMs;
}

/**
 * Header-relative waits are measured against the pinned clock passed in as a
 * fact (#1245): the classifier never reads a clock of its own. Backoff,
 * jitter and caps are the core loop's decision over `afterMs`/`directed` and
 * are tested there (`packages/agent/test/core/retry-decision.test.ts`).
 */
describe("classifyFailure header delays", () => {
  test("no headers: no server-directed wait", () => {
    expect(afterMsOf(retryableError())).toBeUndefined();
  });

  test.each<{ name: string; headers: Record<string, string>; afterMs: number | undefined; directed: boolean | undefined }>([
    { name: "uses Retry-After-Ms header if present", headers: { "retry-after-ms": "5000" }, afterMs: 5000, directed: true },
    { name: "uses Retry-After header (seconds) if Retry-After-Ms not present", headers: { "retry-after": "10" }, afterMs: 10_000, directed: true },
    { name: "falls through an invalid Retry-After-Ms to Retry-After", headers: { "retry-after-ms": "invalid", "retry-after": "3" }, afterMs: 3000, directed: true },
    { name: "an invalid Retry-After leaves no wait", headers: { "retry-after": "invalid" }, afterMs: undefined, directed: undefined },
    { name: "prioritizes Retry-After-Ms over Retry-After", headers: { "retry-after-ms": "3000", "retry-after": "10" }, afterMs: 3000, directed: true },
  ])("$name", ({ headers, afterMs, directed }) => {
    expect(classifyError(retryableError(headers))).toMatchObject({ kind: "retryable", afterMs, directed });
  });

  test.each<{ header: string; value: string; afterMs: number | undefined }>([
    { header: "retry-after", value: "1oops", afterMs: undefined },
    { header: "retry-after", value: "1e3x", afterMs: undefined },
    { header: "retry-after", value: "abc", afterMs: undefined },
    { header: "retry-after", value: "NaN", afterMs: undefined },
    { header: "retry-after", value: "-5", afterMs: undefined },
    { header: "retry-after", value: "0x10", afterMs: undefined },
    { header: "retry-after", value: "1.5", afterMs: undefined },
    { header: "retry-after", value: " 7", afterMs: undefined },
    { header: "retry-after", value: "", afterMs: undefined },
    { header: "retry-after", value: "2026", afterMs: 2_026_000 },
    { header: "retry-after", value: "0", afterMs: 0 },
    { header: "retry-after", value: "9007199254741", afterMs: undefined },
    { header: "retry-after", value: "2026-10-14T00:00:05Z", afterMs: undefined },
    { header: "retry-after-ms", value: "1.5", afterMs: undefined },
    { header: "retry-after-ms", value: "-5", afterMs: undefined },
    { header: "retry-after-ms", value: "1e3x", afterMs: undefined },
    { header: "retry-after-ms", value: "99999999999999999999", afterMs: undefined },
    { header: "retry-after-ms", value: "250", afterMs: 250 },
  ])("strict grammar: $header=\"$value\"", ({ header, value, afterMs }) => {
    expect(afterMsOf(retryableError({ [header]: value }))).toBe(afterMs);
  });

  test("parses Retry-After as HTTP date if not a number", () => {
    const futureDate = new Date(FIXED_RETRY_NOW + 5000).toUTCString();
    expect(afterMsOf(retryableError({ "retry-after": futureDate }))).toBe(5000);
  });

  test("does not throw when error payload code fields are not strings", () => {
    const error = apiError({
      message: JSON.stringify({ type: "error", error: { code: 42, message: 7 } }),
      isRetryable: true,
    });
    expect(classifyError(error)).toMatchObject({ kind: "retryable", providerReason: "server_error" });
  });
});

describe("classifyFailure provider reasons", () => {
  test("classifies non-APIError as terminal non_retryable", () => {
    expect(classifyError(new Error("Retry failed"))).toEqual({
      kind: "terminal",
      reason: "transient_error",
      providerReason: "non_retryable",
      status: undefined,
    });
  });

  const reasonCases: Array<{ name: string; input: SdkErrorInput; expected: ProviderReason }> = [
    {
      name: "classifies APIError with isRetryable false as non_retryable",
      input: { message: "Not found", statusCode: 404, isRetryable: false },
      expected: "non_retryable",
    },
    {
      name: "falls back to status classification when message is not JSON",
      input: { message: "Server error", statusCode: 500, isRetryable: true },
      expected: "server_error",
    },
    {
      name: "classifies 429 by status when payload is primitive JSON",
      input: { message: "null", statusCode: 429, isRetryable: true },
      expected: "rate_limit",
    },
    {
      name: "classifies 429 by status when payload is opaque",
      input: { message: "<html>rate limited</html>", statusCode: 429, isRetryable: true },
      expected: "rate_limit",
    },
    {
      name: "classifies 429 by status when the JSON body has no specific signal",
      input: {
        message: JSON.stringify({
          type: "error",
          error: { message: "request tokens exceeded your per-minute rate limit" },
        }),
        statusCode: 429,
        isRetryable: true,
      },
      expected: "rate_limit",
    },
    {
      name: "classifies from responseBody when message is opaque",
      input: {
        message: "Overloaded",
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
      },
      expected: "rate_limit",
    },
    {
      name: "detects too_many_requests in JSON response",
      input: {
        message: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
        isRetryable: true,
      },
      expected: "rate_limit",
    },
    {
      name: "detects rate_limit in JSON error code",
      input: {
        message: JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }),
        isRetryable: true,
      },
      expected: "rate_limit",
    },
    {
      name: "detects rate_limit in JSON error type (Anthropic rate_limit_error)",
      input: {
        message: JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "rate limited" },
        }),
        isRetryable: true,
      },
      expected: "rate_limit",
    },
    {
      name: "detects server_error in JSON response",
      input: {
        message: JSON.stringify({ type: "error", error: { type: "server_error" } }),
        isRetryable: true,
      },
      expected: "server_error",
    },
    {
      name: "detects exhausted in error code",
      input: { message: JSON.stringify({ code: "quota_exhausted" }), isRetryable: true },
      expected: "overloaded",
    },
    {
      name: "detects unavailable in error code",
      input: { message: JSON.stringify({ code: "service_unavailable" }), isRetryable: true },
      expected: "overloaded",
    },
    {
      name: "detects no_kv_space in error message",
      input: {
        message: JSON.stringify({ error: { message: "no_kv_space" } }),
        isRetryable: true,
      },
      expected: "server_error",
    },
  ];

  test.each(reasonCases)("$name", ({ input, expected }) => {
    const classified = classifyError(apiError(input));
    expect(classified.kind === "retryable" || classified.kind === "terminal" ? classified.providerReason : classified.kind).toBe(expected);
  });

  test("trusts the provider retryable flag when payload and status are opaque", () => {
    const plainText = apiError({ message: "Plain text error", isRetryable: true });
    const invalidJson = apiError({ message: "{ invalid json", isRetryable: true });
    expect(classifyError(plainText)).toMatchObject({ kind: "retryable", providerReason: "server_error" });
    expect(classifyError(invalidJson)).toMatchObject({ kind: "retryable", providerReason: "server_error" });
  });

  test("the attempt reason follows the status: 408 is a timeout, a non-retryable status a validation error", () => {
    expect(classifyError(apiError({ message: "slow", statusCode: 408, isRetryable: true }))).toMatchObject({ reason: "timeout" });
    expect(classifyError(apiError({ message: "bad", statusCode: 400, isRetryable: false }))).toMatchObject({ reason: "validation_error", status: 400 });
    expect(classifyError(apiError({ message: "down", statusCode: 503, isRetryable: true }))).toMatchObject({ reason: "transient_error" });
  });
});

describe("classifyFailure ratelimit-reset parsing (#532 candidate 3)", () => {
  const inferred = (afterMs: number): FailureClass => ({
    kind: "retryable",
    reason: "transient_error",
    providerReason: "rate_limit",
    afterMs,
    directed: false,
    instant: false,
  });
  const headless: FailureClass = {
    kind: "retryable",
    reason: "transient_error",
    providerReason: "rate_limit",
    afterMs: undefined,
    directed: undefined,
    instant: false,
  };

  test("x-ratelimit-reset-requests duration is used when retry-after is absent", () => {
    expect(classifyError(rateLimitError({ "x-ratelimit-reset-requests": "3s" }))).toEqual(inferred(3000));
  });

  test("selects the earliest reset across rate-limit buckets", () => {
    expect(
      classifyError(
        rateLimitError({
          "x-ratelimit-reset-requests": "9s",
          "x-ratelimit-reset-tokens": "2s",
        }),
      ),
    ).toEqual(inferred(2000));
  });

  test("ignores an expired reset timestamp", () => {
    const expired = new Date(FIXED_RETRY_NOW - 1000).toISOString();
    expect(classifyError(rateLimitError({ "anthropic-ratelimit-requests-reset": expired }))).toEqual(headless);
  });

  test("ignores a malformed reset timestamp", () => {
    expect(classifyError(rateLimitError({ "anthropic-ratelimit-requests-reset": "not-a-date" }))).toEqual(headless);
  });

  test("x-ratelimit-reset duration with compound units parses as an inferred (undirected) wait", () => {
    expect(classifyError(rateLimitError({ "x-ratelimit-reset-tokens": "1m30s" }))).toEqual(inferred(90_000));
  });

  test("anthropic-ratelimit reset timestamp is used when retry-after is absent", () => {
    const resetAt = new Date(FIXED_RETRY_NOW + 5000).toISOString();
    expect(classifyError(rateLimitError({ "anthropic-ratelimit-requests-reset": resetAt }))).toEqual(inferred(5000));
  });

  test("retry-after still wins over ratelimit resets, and is a directive", () => {
    expect(classifyError(rateLimitError({ "retry-after": "2", "x-ratelimit-reset-requests": "9s" }))).toMatchObject({
      afterMs: 2000,
      directed: true,
    });
  });

  test("bare numbers in reset headers are never parsed as years", () => {
    expect(classifyError(rateLimitError({ "x-ratelimit-reset-requests": "2027" }))).toEqual(headless);
  });
});
