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

/** A wall clock the test moves forward; see `advancingClock`. */
export interface AdvancingClock {
  readonly clock: Clock.Clock;
  /** Wall time plus every `advance` so far. */
  readonly now: () => number;
  /** Moves time forward by `ms` and wakes every sleep whose deadline that crosses. */
  readonly advance: (ms: number) => void;
}

/**
 * An Effect Clock on wall time plus a test-owned offset. Sleeps stay real
 * until `advance` crosses their deadline, so cluster polling keeps its real
 * cadence while a reaper sweep or a `DeliverAt` instant is reached on demand.
 */
export function advancingClock(): AdvancingClock {
  let offset = 0;
  const now = () => Date.now() + offset;
  const sleepers = new Set<{ readonly deadline: number; readonly wake: () => void }>();
  const sleep = (duration: Duration.Duration) =>
    Effect.callback<void>((resume) => {
      const deadline = now() + Duration.toMillis(duration);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const sleeper = {
        deadline,
        wake: () => {
          clearTimeout(timer);
          sleepers.delete(sleeper);
          resume(Effect.void);
        },
      };
      sleepers.add(sleeper);
      const remaining = deadline - now();
      if (remaining <= MAX_TIMER_MS) timer = setTimeout(sleeper.wake, Math.max(0, remaining));
      return Effect.sync(() => {
        clearTimeout(timer);
        sleepers.delete(sleeper);
      });
    });
  const nanos = () => BigInt(now()) * 1_000_000n;
  return {
    now,
    advance: (ms) => {
      offset += ms;
      for (const sleeper of [...sleepers]) if (sleeper.deadline <= now()) sleeper.wake();
    },
    clock: {
      currentTimeMillisUnsafe: now,
      currentTimeMillis: Effect.sync(now),
      currentTimeNanosUnsafe: nanos,
      currentTimeNanos: Effect.sync(nanos),
      monotonicTimeNanosUnsafe: nanos,
      monotonicTimeNanos: Effect.sync(nanos),
      sleep,
    },
  };
}

/** Longest delay a JS timer honours; longer (and infinite) sleeps wake only through `advance`. */
const MAX_TIMER_MS = 2 ** 31 - 1;

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
