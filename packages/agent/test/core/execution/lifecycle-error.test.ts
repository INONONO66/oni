import { expect, test } from "bun:test";
import { attemptReason, decide } from "../../../src/core/retry";
import { fakeClassifyFailure } from "../../helpers/fake-llm";
import { providerFailure } from "../../helpers/mock-llm";

/** Deterministic injected draw: zero jitter. */
const random = () => 0;

/**
 * The loop's placement facts come from the port's classification (#1352):
 * the recorded attempt reason and the retry verdict are derived from the
 * closed `FailureClass`, never from the provider error itself.
 */
for (const [statusCode, retryable, reason] of [
  [408, true, "timeout"],
  [529, true, "transient_error"],
  [400, false, "validation_error"],
] as const) {
  test(`provider status ${statusCode} produces canonical placement facts`, () => {
    const classified = fakeClassifyFailure({ error: providerFailure("opaque", { statusCode, retryable }) });
    expect(attemptReason(classified)).toBe(reason);
    expect(decide(1, classified, random).retry).toBe(retryable);
  });
}

test("a context overflow is not classified as a generic provider retry", () => {
  const failure = providerFailure("context overflow", {
    contextOverflow: true,
    retryable: false,
    statusCode: 400,
  });
  const classified = fakeClassifyFailure({ error: failure });
  expect(classified).toEqual({ kind: "overflow" });
  expect(attemptReason(classified)).toBe("context_overflow");
  expect(decide(1, classified, random).retry).toBe(false);
});
