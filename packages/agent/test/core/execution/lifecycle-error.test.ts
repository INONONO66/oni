import { expect, test } from "bun:test";
import { Retry } from "../../../src/model";
import { providerFailure } from "../../helpers/mock-llm";

/** Deterministic injected sources: frozen clock, zero jitter. */
const sources = { now: () => 0, random: () => 0 };

for (const [statusCode, retryable, reason] of [
  [408, true, "timeout"],
  [529, true, "transient_error"],
  [400, false, "validation_error"],
] as const) {
  test(`provider status ${statusCode} produces canonical placement facts`, () => {
    const failure = providerFailure("opaque", { statusCode, retryable });
    expect(Retry.attemptReason(failure)).toBe(reason);
    expect(Retry.decide(1, failure, sources).retry).toBe(retryable);
  });
}

test("a context overflow is not classified as a generic provider retry", () => {
  const failure = providerFailure("context overflow", {
    contextOverflow: true,
    retryable: false,
    statusCode: 400,
  });
  expect(Retry.isContextOverflow(failure)).toBe(true);
  expect(Retry.attemptReason(failure)).toBe("context_overflow");
  expect(Retry.decide(1, failure, sources).retry).toBe(false);
});
