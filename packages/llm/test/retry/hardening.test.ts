import { describe, expect, test } from "bun:test";
import type { ProviderReason, RetryableProviderReason } from "../../src/port";

import { apiError, classifyError, providerReasonOf, rateLimitError, type SdkErrorInput } from "../helpers/retry";

describe("billing classification", () => {
  const billingCases: Array<{ name: string; input: SdkErrorInput }> = [
    {
      name: "insufficient_quota code",
      input: {
        message: JSON.stringify({ error: { code: "insufficient_quota", message: "no credit" } }),
        isRetryable: true,
        statusCode: 429,
      },
    },
    {
      name: "quota exceeded prose",
      input: {
        message: JSON.stringify({
          error: { message: "You exceeded your current quota, please check your plan" },
        }),
        isRetryable: true,
        statusCode: 429,
      },
    },
    {
      name: "out of budget prose",
      input: { message: "organization is out of budget", isRetryable: true, statusCode: 429 },
    },
    {
      name: "billing prose",
      input: {
        message: JSON.stringify({ error: { type: "billing_error", message: "billing required" } }),
        isRetryable: true,
        statusCode: 400,
      },
    },
    {
      name: "monthly usage limit prose",
      input: {
        message: "monthly usage limit reached for this workspace",
        isRetryable: true,
        statusCode: 429,
      },
    },
    {
      name: "quota exhaustion reported in the response body",
      input: {
        message: "Request failed",
        isRetryable: true,
        statusCode: 429,
        responseBody: JSON.stringify({ error: { code: "insufficient_quota" } }),
      },
    },
  ];

  test.each(billingCases)("$name is terminal", ({ input }) => {
    const classified = classifyError(apiError(input));

    expect(classified.kind).toBe("terminal");
    if (classified.kind !== "terminal") expect.unreachable("billing exhaustion must not be retryable");
    expect(classified.providerReason).toBe("billing");
  });

  test("billing outranks the provider's retryable flag", () => {
    expect(classifyError(apiError({ message: "insufficient_quota", isRetryable: true }))).toMatchObject({
      kind: "terminal",
      providerReason: "billing",
    });
  });

  test("billing outranks a retry-after header — no wait rescues a spent balance", () => {
    const classified = classifyError(
      apiError({
        message: "insufficient_quota",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: { "retry-after": "5" },
      }),
    );

    expect(classified).toEqual({ kind: "terminal", reason: "transient_error", providerReason: "billing", status: 429 });
  });

  test.each([
    {
      message: "billing service temporarily unavailable; retry later",
      statusCode: 503,
      reason: "server_error",
    },
    {
      message: "request exceeded your per minute quota; retry after 1 second",
      statusCode: 429,
      reason: "rate_limit",
    },
    { message: "quota exceeded for this minute", statusCode: 429, reason: "rate_limit" },
  ])("does not confuse transient failures with spent balances: $message", ({
    message,
    statusCode,
    reason,
  }) => {
    expect(classifyError(apiError({ message, isRetryable: true, statusCode }))).toMatchObject({ kind: "retryable", providerReason: reason });
  });

  test("a transient 429 is NOT billing — rate limits stay retryable with their directed wait", () => {
    const classified = classifyError(
      apiError({
        message: JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "request rate limit exceeded" },
        }),
        isRetryable: true,
        statusCode: 429,
        responseHeaders: { "retry-after": "5" },
      }),
    );

    expect(classified).toEqual({
      kind: "retryable",
      reason: "transient_error",
      providerReason: "rate_limit",
      afterMs: 5000,
      directed: true,
      instant: false,
    });
  });

  test("a bare 429 with no retry-after and no quota headers stays retryable with no directed wait", () => {
    expect(classifyError(rateLimitError())).toMatchObject({ kind: "retryable", providerReason: "rate_limit", afterMs: undefined });
  });

  test("keeps `quota_exhausted` on the transient overloaded path", () => {
    // Capacity exhaustion, not balance exhaustion: the provider is telling us
    // to come back, not that the account is spent.
    expect(providerReasonOf(apiError({ message: JSON.stringify({ code: "quota_exhausted" }), isRetryable: true }))).toBe("overloaded");
  });

  test("billing is terminal vocabulary — never a retryable reason", () => {
    // Compile-time half: billing must not widen the retryable vocabulary the
    // processor's exhaustive RateLimited switch is written against. check-types
    // fails if the @ts-expect-error stops being an error.
    // @ts-expect-error "billing" is deliberately outside RetryableProviderReason.
    const widened: RetryableProviderReason = "billing" as ProviderReason;
    void widened;

    // Runtime half: no retryable classification can carry it.
    expect(classifyError(apiError({ message: "billing required", isRetryable: true })).kind).toBe("terminal");
  });
});
