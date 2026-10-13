import { describe, expect, test } from "bun:test";
import type { Token } from "@openomni/protocol";
import { accumulateUsage, type FailureClass } from "../../src/core/llm";
import { attemptReason } from "../../src/core/retry";

describe("public accounting and attempt classification", () => {
  test("accumulates billed counts without billing auxiliary counters twice", () => {
    const total: Token.AgentUsage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
    accumulateUsage(total, {
      inputTokens: 4,
      outputTokens: 5,
      reasoningTokens: 6,
      cacheReadTokens: 7,
      cacheWriteTokens: 8,
    });
    expect(total).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      reasoningTokens: 6,
      cacheReadTokens: 7,
      cacheWriteTokens: 8,
    });
    accumulateUsage(total, { inputTokens: 0, outputTokens: 0 });
    accumulateUsage(total, {
      inputTokens: 2,
      outputTokens: 3,
      reasoningTokens: 1,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
    });
    expect(total).toEqual({
      inputTokens: 7,
      outputTokens: 10,
      totalTokens: 17,
      reasoningTokens: 7,
      cacheReadTokens: 9,
      cacheWriteTokens: 11,
    });
  });

  test.each<[FailureClass, ReturnType<typeof attemptReason>]>([
    [{ kind: "overflow" }, "context_overflow"],
    [{ kind: "retryable", reason: "timeout", providerReason: "server_error", instant: false }, "timeout"],
    [{ kind: "terminal", reason: "validation_error", providerReason: "non_retryable", status: 400 }, "validation_error"],
    [{ kind: "retryable", reason: "transient_error", providerReason: "overloaded", instant: false }, "transient_error"],
    [{ kind: "aborted" }, "transient_error"],
  ])("records the classified attempt %j as %s", (failure, expected) => {
    expect(attemptReason(failure)).toBe(expected);
  });
});
