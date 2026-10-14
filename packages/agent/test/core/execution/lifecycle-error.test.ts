import { expect, test } from "bun:test";
import { attemptReason, decide } from "../../../src/core/loop/retry";
import type { FailureClass } from "../../../src/core/ports/llm";

/** Deterministic injected draw: zero jitter. */
const random = () => 0;

/** The core consumes the port's closed verdict, never an error's provider fields. */
for (const [statusCode, retryable, reason, classified] of [
  [408, true, "timeout", { kind: "retryable", reason: "timeout", providerReason: "server_error", instant: false }],
  [529, true, "transient_error", { kind: "retryable", reason: "transient_error", providerReason: "server_error", instant: false }],
  [400, false, "validation_error", { kind: "terminal", reason: "validation_error", providerReason: "non_retryable", status: 400 }],
] as const satisfies readonly (readonly [number, boolean, string, FailureClass])[]) {
  test(`provider status ${statusCode} produces canonical placement facts`, () => {
    expect(attemptReason(classified)).toBe(reason);
    expect(decide(1, classified, random).retry).toBe(retryable);
  });
}

test("a context overflow is not classified as a generic provider retry", () => {
  const classified = { kind: "overflow" } as const;
  expect(attemptReason(classified)).toBe("context_overflow");
  expect(decide(1, classified, random).retry).toBe(false);
});
