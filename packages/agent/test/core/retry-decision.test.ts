import { describe, expect, test } from "bun:test";
import { LlmCall, Operational } from "@openomni/protocol";
import type { FailureClass } from "../../src/core/ports/llm";
import {
  decide,
  INSTANT_FAILURE_STREAK_LIMIT,
  INSTANT_FAILURE_WINDOW_MS,
  INSTANT_FAILURE_PROBE_DELAY_MS,
  isInstantFailure,
  MAX_ATTEMPTS,
  observeRetry,
  RETRY_BACKOFF_FACTOR,
  RETRY_HEADER_DELAY_CAP,
  RETRY_INITIAL_DELAY,
  RETRY_JITTER_RATIO,
  RETRY_MAX_DELAY_NO_HEADERS,
} from "../../src/core/loop/retry";
import { collector } from "../helpers/observation-collector";

/**
 * The retry decision is the loop's, taken over the port's classification
 * (#1352): delay ladder, jitter, header caps, the instant-failure streak and
 * the validation fallback never read an SDK error. Classification itself is
 * tested beside its provider decoder in `packages/llm`.
 */
const zero = () => 0;

function retryable(overrides: Partial<Extract<FailureClass, { kind: "retryable" }>> = {}): FailureClass {
  return { kind: "retryable", reason: "transient_error", providerReason: "rate_limit", instant: false, ...overrides };
}

const terminal = (providerReason: "billing" | "content_policy" | "non_retryable", status?: number): FailureClass => ({
  kind: "terminal",
  reason: "validation_error",
  providerReason,
  status,
});

describe("decide: kinds that never retry", () => {
  test("an abort is non_retryable, before any attempt accounting", () => {
    expect(decide(1, { kind: "aborted" }, zero)).toEqual({ retry: false, reason: "non_retryable" });
  });

  test("overflow is non_retryable: the loop hands it to the compaction producer", () => {
    expect(decide(1, { kind: "overflow" }, zero)).toEqual({ retry: false, reason: "non_retryable" });
  });

  test.each(["billing", "content_policy"] as const)("%s is terminal with its owner-facing detail", (reason) => {
    const decision = decide(1, terminal(reason, 402), zero);
    expect(decision.retry).toBe(false);
    if (decision.retry) expect.unreachable("terminal provider reasons must not retry");
    expect(decision.reason).toBe(reason);
    expect(decision.detail).toBeDefined();
  });

  test("billing outranks an instant-failure streak and a directed wait", () => {
    expect(decide(1, terminal("billing"), zero, INSTANT_FAILURE_STREAK_LIMIT - 1)).toMatchObject({ retry: false, reason: "billing" });
  });

  test("a non-retryable failure is non_retryable without fallback", () => {
    expect(decide(1, terminal("non_retryable", 404), zero)).toEqual({ retry: false, reason: "non_retryable" });
  });
});

describe("decide: validation fallback", () => {
  test("a 400 with a fallback available retries once, immediately, as validation_error so the loop can switch", () => {
    expect(decide(1, terminal("non_retryable", 400), zero, 0, true)).toEqual({ retry: true, reason: "validation_error", delayMs: 0 });
  });

  test("no fallback: a 400 stays terminal", () => {
    expect(decide(1, terminal("non_retryable", 400), zero, 0, false)).toEqual({ retry: false, reason: "non_retryable" });
  });

  test("a fallback never rescues a non-400 terminal failure", () => {
    expect(decide(1, terminal("non_retryable", 404), zero, 0, true)).toEqual({ retry: false, reason: "non_retryable" });
  });
});

/**
 * The backoff ladder is jittered by `1 - random*RETRY_JITTER_RATIO`, so every
 * assertion about a LADDER delay pins the injected draw instead of allowing a
 * range: a draw of 0 is the full ladder value. Server-directed delays are
 * never jittered and need no pin.
 */
function delayOf(attempt: number, failure: FailureClass, random: () => number = zero): number {
  const decision = decide(attempt, failure, random);
  if (!decision.retry) throw new Error(`expected a retry decision, got ${decision.reason}`);
  return decision.delayMs;
}

describe("decide: delay ladder", () => {
  test("exponential backoff without a directed wait", () => {
    expect(delayOf(1, retryable())).toBe(2000);
    expect(delayOf(2, retryable())).toBe(4000);
    expect(delayOf(3, retryable())).toBe(8000);
    expect(delayOf(4, retryable())).toBe(16_000);
    expect(RETRY_INITIAL_DELAY * RETRY_BACKOFF_FACTOR).toBe(4000);
  });

  test("caps headerless backoff at RETRY_MAX_DELAY_NO_HEADERS", () => {
    expect(delayOf(20, retryable())).toBe(RETRY_MAX_DELAY_NO_HEADERS);
  });

  test("a server-directed wait within the cap is honored exactly", () => {
    expect(decide(1, retryable({ afterMs: 45_000, directed: true }), zero)).toEqual({ retry: true, reason: "rate_limit", delayMs: 45_000 });
    expect(delayOf(1, retryable({ afterMs: 5000, directed: true }))).toBe(5000);
  });

  test("an inferred reset within the cap is used as the wait", () => {
    expect(decide(1, retryable({ afterMs: 2000, directed: false }), zero)).toEqual({ retry: true, reason: "rate_limit", delayMs: 2000 });
  });

  test("an explicit directive above the cap fails fast instead of silently stalling", () => {
    const decision = decide(1, retryable({ afterMs: 3_600_000, directed: true }), zero);
    expect(decision.retry).toBe(false);
    if (!decision.retry) {
      expect(decision.reason).toBe("rate_limit");
      expect(decision.detail).toContain("3600000");
    }
    expect(RETRY_HEADER_DELAY_CAP).toBe(60_000);
  });

  test("an inferred reset above the cap demotes to backoff and says so", () => {
    expect(decide(1, retryable({ afterMs: 90_000, directed: false }), zero)).toEqual({
      retry: true,
      reason: "rate_limit",
      delayMs: RETRY_INITIAL_DELAY,
      retryAfterOverCap: true,
    });
  });

  test("the attempt cap is the loop's constant", () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });
});

describe("decide: backoff jitter", () => {
  test("subtracts up to 25% of the ladder delay, scaled by the injected random draw", () => {
    // random=0 → the full delay; random=1 → the 25% floor. Both ends pinned so
    // the multiplier itself is the assertion, not a tolerance band.
    expect(RETRY_JITTER_RATIO).toBe(0.25);
    expect(delayOf(1, retryable(), () => 0)).toBe(RETRY_INITIAL_DELAY);
    expect(delayOf(1, retryable(), () => 1)).toBe(RETRY_INITIAL_DELAY * 0.75);
    expect(delayOf(2, retryable(), () => 0.5)).toBe(4000 * 0.875);
  });

  test("two consecutive decisions on the same attempt do not collide", () => {
    // The point of jitter: a fleet retrying the same failure spreads out
    // instead of stampeding the endpoint on the same tick.
    const draws = [0.1, 0.9];
    let index = 0;
    const random = () => draws[index++] ?? 0;
    expect(delayOf(3, retryable(), random)).not.toBe(delayOf(3, retryable(), random));
  });

  test("never jitters a server-directed wait", () => {
    expect(delayOf(1, retryable({ afterMs: 10_000, directed: true }), () => 1)).toBe(10_000);
  });

  test("stays within the headless cap at every draw", () => {
    expect(delayOf(20, retryable(), () => 0)).toBe(RETRY_MAX_DELAY_NO_HEADERS);
    expect(delayOf(20, retryable(), () => 1)).toBe(RETRY_MAX_DELAY_NO_HEADERS * 0.75);
  });
});

describe("decide: instant-failure streak", () => {
  const transport = (): FailureClass => retryable({ instant: true, providerReason: "server_error" });

  test("isInstantFailure needs both halves: the transport verdict and an elapsed time under the window", () => {
    expect(isInstantFailure(transport(), 100)).toBe(true);
    expect(isInstantFailure(transport(), INSTANT_FAILURE_WINDOW_MS - 1)).toBe(true);
    expect(isInstantFailure(transport(), INSTANT_FAILURE_WINDOW_MS)).toBe(false);
    expect(isInstantFailure(transport(), 30_000)).toBe(false);
    expect(isInstantFailure(retryable({ instant: false }), 0)).toBe(false);
    expect(isInstantFailure({ kind: "aborted" }, 0)).toBe(false);
  });

  test("below the limit: retries on the short probe delay, not the backoff ladder", () => {
    const decision = decide(2, transport(), zero, 2);
    expect(decision).toEqual({ retry: true, reason: "server_error", delayMs: INSTANT_FAILURE_PROBE_DELAY_MS });
    expect(INSTANT_FAILURE_PROBE_DELAY_MS).toBeLessThan(RETRY_INITIAL_DELAY);
  });

  test("at the limit: declines with a detail naming the transport streak", () => {
    const decision = decide(3, transport(), zero, INSTANT_FAILURE_STREAK_LIMIT);
    expect(decision.retry).toBe(false);
    if (!decision.retry) {
      expect(decision.reason).toBe("server_error");
      expect(decision.detail).toContain("transport");
    }
    expect(INSTANT_FAILURE_STREAK_LIMIT).toBe(3);
  });

  test("a zero streak keeps the ladder", () => {
    expect(decide(1, transport(), zero, 0)).toEqual({ retry: true, reason: "server_error", delayMs: RETRY_INITIAL_DELAY });
  });

  test("the streak never overrides a terminal classification", () => {
    expect(decide(1, terminal("non_retryable"), zero, INSTANT_FAILURE_STREAK_LIMIT)).toEqual({ retry: false, reason: "non_retryable" });
  });
});

describe("observeRetry", () => {
  const identity = { traceId: "trace", sessionId: "session", runId: "run", provider: "anthropic", attempt: 1, maxAttempts: MAX_ATTEMPTS, now: () => 1234 };

  test("a rate-limit retry publishes RetryDecided and RateLimited with the selected delay", () => {
    const events = collector();
    observeRetry(events, { ...identity, decision: { retry: true, reason: "rate_limit", delayMs: 1 } });
    expect(events.named(LlmCall.Events.RetryDecided.name)).toMatchObject([
      { attempt: 1, maxAttempts: MAX_ATTEMPTS, reason: "rate_limit", backoffMs: 1, runId: "run", time: 1234 },
    ]);
    expect(events.named(LlmCall.Events.RateLimited.name)).toMatchObject([{ provider: "anthropic", retryAfterMs: 1, time: 1234 }]);
    expect(events.named(Operational.Events.Warn.name)).toEqual([]);
  });

  test("an over-cap demotion publishes its selected delay as a warning", () => {
    const decision = decide(1, retryable({ afterMs: 90_000, directed: false }), zero);
    if (!decision.retry) throw new Error("expected retry");
    const events = collector();
    observeRetry(events, { ...identity, decision });
    expect(events.named(Operational.Events.Warn.name)).toMatchObject([{ context: { backoffMs: decision.delayMs }, time: 1234 }]);
  });
});
