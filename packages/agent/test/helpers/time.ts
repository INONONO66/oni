import { Clock, Duration, Effect, Layer } from "effect";
import type { EntropySource } from "../../src/core/ports/ports";

/**
 * An Effect Clock whose wall time is the fixture's `now` function; sleeping
 * stays real so nothing passes by timing luck. Monotonic time mirrors wall
 * time — fixtures that freeze the clock mean "no time passes".
 */
export function fixedClock(now: () => number): Clock.Clock {
  const millis = Effect.sync(now);
  const nanos = Effect.sync(() => BigInt(now()) * 1_000_000n);
  return {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: millis,
    currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
    currentTimeNanos: nanos,
    monotonicTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
    monotonicTimeNanos: nanos,
    sleep: (duration) => Effect.promise(() => Bun.sleep(Duration.toMillis(duration))),
  };
}

export function fixedClockLayer(now: () => number) {
  return Layer.succeed(Clock.Clock, fixedClock(now));
}

/** A deterministic EntropySource: prefixed counter ids, fixed random. */
export function entropySource(prefix = "id"): EntropySource {
  let n = 0;
  return { id: () => { n += 1; return `${prefix}-${n}`; }, random: () => 0 };
}

let entropyInstances = 0;
/**
 * Deterministic-shape ids that stay unique across fixture instances and
 * processes: crash/recovery fixtures reopen the same chain and must never
 * re-mint a committed action id (the kernel refuses duplicate ids).
 */
export function uniqueEntropy(prefix: string): () => string {
  const instance = `${process.pid.toString(36)}-${++entropyInstances}`;
  let n = 0;
  return () => `${prefix}-${instance}-${++n}`;
}
