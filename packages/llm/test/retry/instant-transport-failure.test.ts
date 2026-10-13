import { describe, expect, test } from "bun:test";
import { apiError, classifyError } from "../helpers/retry";

function transportError(): ReturnType<typeof apiError> {
  // A connection-level failure: retryable, but no HTTP response ever arrived,
  // so there is no status code and there are no response headers.
  return apiError({ message: "fetch failed", isRetryable: true });
}

function httpError(statusCode: number): ReturnType<typeof apiError> {
  return apiError({ message: "boom", isRetryable: true, statusCode });
}

function instantOf<E>(error: E): boolean | undefined {
  const classified = classifyError(error);
  return classified.kind === "retryable" ? classified.instant : undefined;
}

/**
 * `instant` is the transport half of the instant-failure signature: the
 * endpoint never answered. The elapsed-time half, the probe delay and the
 * streak limit are the core loop's (`packages/agent/test/core/retry-decision.test.ts`).
 */
describe("classifyFailure instant transport failures", () => {
  test("true for a retryable no-status failure", () => {
    expect(instantOf(transportError())).toBe(true);
  });

  test("false when an HTTP response arrived — the endpoint is up", () => {
    expect(instantOf(httpError(429))).toBe(false);
    expect(instantOf(httpError(500))).toBe(false);
  });

  test("false when response headers arrived without a status — the endpoint answered", () => {
    const headerOnly = apiError({
      message: "rate limited",
      isRetryable: true,
      responseHeaders: { "retry-after-ms": "1" },
    });
    expect(instantOf(headerOnly)).toBe(false);
  });

  test("a wrapped transport failure is read through the cause chain", () => {
    const wrapped = new Error("provider call failed", { cause: transportError().cause });
    expect(classifyError(wrapped)).toMatchObject({ kind: "retryable", providerReason: "server_error", instant: true });
  });

  test("non-APIError values are terminal, never instant", () => {
    expect(classifyError(new Error("nope"))).toMatchObject({ kind: "terminal", providerReason: "non_retryable" });
    expect(classifyError(undefined)).toMatchObject({ kind: "terminal", providerReason: "non_retryable" });
  });
});
