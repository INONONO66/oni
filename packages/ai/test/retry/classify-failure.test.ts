import { describe, expect, test } from "bun:test";
import { coerceApiError } from "../../src/error";
import { type Run, LlmRunFailure } from "../helpers/native";
import { classifyFailure } from "../../src/classify";

import { apiError, providerReasonOf, sdkError } from "../helpers/retry";

function runFailure(cause: Error): Run.Failure {
  const api = coerceApiError(cause);
  return new LlmRunFailure({
    message: api?.message ?? "the model call failed",
    cause: api ?? String(cause),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    aborted: false,
    contextOverflow: false,
    visibleOutput: false,
  });
}

describe("classifyFailure provider reason", () => {
  test("classifies a typed APIError directly", () => {
    expect(
      providerReasonOf(
        apiError({ message: "rate limited", isRetryable: true, statusCode: 429 }),
      ),
    ).toBe("rate_limit");
  });

  test("coerces a raw AI SDK provider error", () => {
    expect(
      providerReasonOf(
        sdkError({ message: "rate limited", isRetryable: true, statusCode: 429 }),
      ),
    ).toBe("rate_limit");
  });

  test("walks the cause chain of the package's own terminal failure", () => {
    const failure = runFailure(
      apiError({ message: "insufficient_quota", isRetryable: true, statusCode: 429 }),
    );

    expect(providerReasonOf(failure)).toBe("billing");
  });

  test("walks a nested cause chain rather than stopping at the first wrapper", () => {
    const wrapped = new Error("agent run failed", {
      cause: runFailure(
        sdkError({ message: "insufficient_quota", isRetryable: true, statusCode: 429 }),
      ),
    });

    expect(providerReasonOf(wrapped)).toBe("billing");
  });

  test("classifies a declined-card billing error as terminal", () => {
    expect(
      providerReasonOf(
        apiError({
          message: "billing_error: card declined",
          isRetryable: false,
          statusCode: 402,
        }),
      ),
    ).toBe("billing");
  });

  test("reports non_retryable for an error carrying no provider facts", () => {
    expect(providerReasonOf(new Error("socket hang up"))).toBe("non_retryable");
  });

  test("terminates on a self-referential cause chain", () => {
    const looping = new Error("loop");
    looping.cause = looping;

    expect(providerReasonOf(looping)).toBe("non_retryable");
  });
});

describe("content-policy classification", () => {
  test.each([
    {
      name: "an OpenAI content_policy_violation code",
      input: {
        message: JSON.stringify({
          error: { type: "invalid_request_error", code: "content_policy_violation" },
        }),
        isRetryable: false,
        statusCode: 400,
      },
    },
    {
      name: "an Anthropic content-filter refusal in the body",
      input: {
        message: "Request failed",
        isRetryable: false,
        statusCode: 400,
        responseBody: JSON.stringify({ error: { type: "content_filter" } }),
      },
    },
    {
      name: "a moderation-blocked prose message",
      input: {
        message: "The request was blocked by our content policy",
        isRetryable: false,
        statusCode: 400,
      },
    },
  ])("$name classifies as content_policy", ({ input }) => {
    expect(providerReasonOf(apiError(input))).toBe("content_policy");
  });

  test("a content-policy refusal classifies terminal even when the provider flags it retryable", () => {
    const classified = classifyFailure({
      error: apiError({
        message: "The request was blocked by our content policy",
        isRetryable: true,
        statusCode: 400,
      }),
    });

    expect(classified).toEqual({ kind: "terminal", reason: "transient_error", providerReason: "content_policy", status: 400 });
  });

  test("does not confuse a policy DISCUSSION with a policy refusal", () => {
    // The prose names a policy without being a moderation verdict: a 500 that
    // merely mentions the words must stay on the server-error path.
    expect(
      providerReasonOf(
        apiError({
          message: "our content policy documentation service is unavailable",
          isRetryable: true,
          statusCode: 503,
        }),
      ),
    ).toBe("server_error");
  });
});
