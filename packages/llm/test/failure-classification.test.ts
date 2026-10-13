import { describe, expect, test } from "bun:test";
import { classifyFailure, isContextOverflow, NEAR_WINDOW_RATIO } from "../src/classify";
import { LlmRunFailure } from "../src/errors";
import type { FailureFacts } from "../src/port";
import { FIXED_RETRY_NOW, rateLimitError, sdkError } from "./helpers/retry";

/**
 * The port's `classifyFailure` is pure and exhaustive (#1352): every fact set
 * lands in exactly one of aborted / overflow / retryable / terminal. Overflow
 * is decided here, from the provider's own declaration, its message text, or
 * usage against the model's window — the loop only routes the kind.
 */
const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function runFailure(fields: Partial<ConstructorParameters<typeof LlmRunFailure>[0]> = {}): LlmRunFailure {
  return new LlmRunFailure({ message: "the model call failed", usage, aborted: false, contextOverflow: false, visibleOutput: false, ...fields });
}

const WINDOW = 200_000;

describe("classifyFailure: aborted", () => {
  test("a typed failure that declares the abort", () => {
    expect(classifyFailure({ error: runFailure({ aborted: true }) })).toEqual({ kind: "aborted" });
  });

  test("a bare AbortError from the signal", () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    expect(classifyFailure({ error })).toEqual({ kind: "aborted" });
  });

  test("an abort outranks a declared overflow on the same failure", () => {
    expect(classifyFailure({ error: runFailure({ aborted: true, contextOverflow: true }) })).toEqual({ kind: "aborted" });
  });
});

describe("classifyFailure: overflow", () => {
  test("declared on the typed failure", () => {
    expect(classifyFailure({ error: runFailure({ contextOverflow: true }) })).toEqual({ kind: "overflow" });
  });

  test("a typed failure that declares no overflow does not fall back to its text", () => {
    // The provider's verdict is authoritative once given: `contextOverflow:false`
    // on a run failure whose message happens to mention the window is not overflow.
    expect(classifyFailure({ error: runFailure({ message: "prompt is too long for the context window", contextOverflow: false }) }).kind).toBe("terminal");
  });

  test.each([
    "context_length_exceeded",
    "This model's maximum context length is 8192 tokens",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "Request exceeds the context window",
    "too many tokens",
    "The input token count exceeds the maximum number of tokens allowed.",
    "Input is too long for requested model.",
  ])("named in the provider text: %s", (message) => {
    const error = sdkError({ message, isRetryable: false, statusCode: 400 });
    expect(isContextOverflow(error)).toBe(true);
    expect(classifyFailure({ error })).toEqual({ kind: "overflow" });
  });

  test.each(["exceeded token rate limit of your current tier", "context deadline exceeded"])(
    "provider text that is not the window: %s",
    (message) => {
      expect(isContextOverflow(new Error(message))).toBe(false);
      expect(classifyFailure({ error: new Error(message) }).kind).not.toBe("overflow");
    },
  );

  test("a normal stop whose prompt (input plus cached reads) exceeded the window", () => {
    const facts: FailureFacts = { usage: { inputTokens: 150_000, outputTokens: 10, cacheReadTokens: 60_000 }, finishReason: "stop", contextWindow: WINDOW };
    expect(classifyFailure(facts)).toEqual({ kind: "overflow" });
  });

  test("a normal stop at exactly the window is not overflow", () => {
    expect(classifyFailure({ usage: { inputTokens: WINDOW, outputTokens: 10 }, finishReason: "stop", contextWindow: WINDOW }).kind).not.toBe("overflow");
  });

  test("a length stop with no output and the prompt at the near-window ratio", () => {
    expect(NEAR_WINDOW_RATIO).toBe(0.99);
    const prompt = Math.ceil(WINDOW * NEAR_WINDOW_RATIO);
    expect(classifyFailure({ usage: { inputTokens: prompt, outputTokens: 0 }, finishReason: "length", contextWindow: WINDOW })).toEqual({ kind: "overflow" });
  });

  test("a length stop that produced output is the output cap, not the window", () => {
    expect(classifyFailure({ usage: { inputTokens: WINDOW, outputTokens: 1 }, finishReason: "length", contextWindow: WINDOW }).kind).not.toBe("overflow");
  });

  test("a length stop with no output but the prompt under the ratio is not overflow", () => {
    const prompt = Math.floor(WINDOW * NEAR_WINDOW_RATIO) - 1;
    expect(classifyFailure({ usage: { inputTokens: prompt, outputTokens: 0 }, finishReason: "length", contextWindow: WINDOW }).kind).not.toBe("overflow");
  });

  test("never reclassifies from missing usage or a missing window", () => {
    expect(classifyFailure({ finishReason: "stop", contextWindow: WINDOW }).kind).not.toBe("overflow");
    expect(classifyFailure({ usage: { inputTokens: WINDOW * 2, outputTokens: 0 }, finishReason: "stop" }).kind).not.toBe("overflow");
    expect(classifyFailure({ usage: { inputTokens: WINDOW * 2, outputTokens: 0 }, finishReason: "stop", contextWindow: 0 }).kind).not.toBe("overflow");
  });

  test("a tool-call or other stop never overflows by usage", () => {
    expect(classifyFailure({ usage: { inputTokens: WINDOW * 2, outputTokens: 0 }, finishReason: "tool-calls", contextWindow: WINDOW }).kind).not.toBe("overflow");
  });
});

describe("classifyFailure: terminal", () => {
  test("billing exhaustion carries its provider reason and status", () => {
    const error = sdkError({ message: "insufficient_quota", isRetryable: false, statusCode: 402 });
    expect(classifyFailure({ error })).toEqual({ kind: "terminal", reason: "validation_error", providerReason: "billing", status: 402 });
  });

  test("a non-retryable 400 keeps its status so the loop can decide the validation fallback", () => {
    const error = sdkError({ message: "bad request", isRetryable: false, statusCode: 400 });
    expect(classifyFailure({ error })).toEqual({ kind: "terminal", reason: "validation_error", providerReason: "non_retryable", status: 400 });
  });

  test("a terminal class never carries prose: the decision owns the detail", () => {
    const classified = classifyFailure({ error: sdkError({ message: "insufficient_quota", isRetryable: false, statusCode: 402 }) });
    expect(Object.keys(classified).sort()).toEqual(["kind", "providerReason", "reason", "status"]);
  });
});

describe("classifyFailure: retryable", () => {
  test("a rate limit with a directed header wait, measured against the injected clock", () => {
    expect(classifyFailure({ error: rateLimitError({ "retry-after-ms": "1500" }), now: FIXED_RETRY_NOW })).toEqual({
      kind: "retryable",
      reason: "transient_error",
      providerReason: "rate_limit",
      afterMs: 1500,
      directed: true,
      instant: false,
    });
  });

  test("a rate limit without headers carries no wait", () => {
    expect(classifyFailure({ error: rateLimitError(), now: FIXED_RETRY_NOW })).toMatchObject({ kind: "retryable", providerReason: "rate_limit", afterMs: undefined, directed: undefined, instant: false });
  });

  test("a 408 is the timeout attempt reason", () => {
    expect(classifyFailure({ error: sdkError({ message: "timeout", isRetryable: true, statusCode: 408 }) })).toMatchObject({ kind: "retryable", reason: "timeout" });
  });

  test("a retryable failure with neither status nor headers is instant: transport answered, not the endpoint", () => {
    expect(classifyFailure({ error: sdkError({ message: "fetch failed", isRetryable: true }) })).toMatchObject({ kind: "retryable", providerReason: "server_error", instant: true });
  });

  // Without an SDK cause nothing proves the endpoint is worth another call:
  // the pre-#1352 `Retry.decide` refused these too (`non_retryable`).
  test("an unknown non-SDK error is terminal, never speculated retryable", () => {
    expect(classifyFailure({ error: new Error("socket hang up") })).toEqual({
      kind: "terminal",
      reason: "transient_error",
      providerReason: "non_retryable",
      status: undefined,
    });
  });

  test("no facts at all is terminal", () => {
    expect(classifyFailure({})).toMatchObject({ kind: "terminal", reason: "transient_error", providerReason: "non_retryable" });
  });
});
