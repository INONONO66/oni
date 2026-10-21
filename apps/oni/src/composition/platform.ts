import { randomUUID } from "node:crypto";
import { Clock, Effect, Fiber, Layer, type Context } from "effect";
import type { Core } from "@oni/agent";
type EntropySource = Core.EntropySource;

export interface AppScheduler {
  schedule(delayMs: number, task: () => void): () => void;
  close(): void;
}

/** One runtime scheduler seam shared by machine reports and reconnects. */
export function effectScheduler(context: Context.Context<never>): AppScheduler {
  const fibers = new Set<Fiber.Fiber<void, never>>();
  return {
    schedule(delayMs, task) {
      let fiber: Fiber.Fiber<void, never> | undefined;
      fiber = Effect.runForkWith(context)(
        Effect.sleep(delayMs).pipe(
          Effect.tap(() => Effect.sync(task)),
          Effect.ensuring(Effect.sync(() => { if (fiber !== undefined) fibers.delete(fiber); })),
        ),
      );
      fibers.add(fiber);
      return () => { void Effect.runPromiseWith(context)(Fiber.interrupt(fiber)); };
    },
    close() {
      for (const fiber of fibers) void Effect.runPromiseWith(context)(Fiber.interrupt(fiber));
      fibers.clear();
    },
  };
}

/**
 * The composition root's only ambient entropy (#1245): node's CSPRNG for ids,
 * webcrypto words for uniform randoms. Every other module receives these as
 * required options or through the Entropy service; no `crypto.randomUUID` or
 * `Math.random` read exists outside this file.
 */
export function platformEntropy(): EntropySource {
  return {
    id: () => randomUUID(),
    random: () => {
      const words = new Uint32Array(1);
      crypto.getRandomValues(words);
      return (words[0] ?? 0) / 2 ** 32;
    },
  };
}

/**
 * Promise-side wall clock, captured ONCE at bootstrap from Effect's default
 * Clock (never re-read ambiently). Effect code keeps using `Clock` directly.
 */
export const captureNow: Effect.Effect<() => number> = Clock.clockWith((clock) =>
  Effect.succeed(() => clock.currentTimeMillisUnsafe()),
);

/**
 * An Effect Clock whose wall-time reads come from the injected `now` while
 * sleeps and monotonic reads keep the `base` clock's behavior — the seam
 * tests use to pin deterministic time over a whole app runtime.
 */
function wallClockOverride(now: () => number, base: Clock.Clock): Clock.Clock {
  return {
    currentTimeMillisUnsafe: () => now(),
    currentTimeMillis: Effect.sync(() => now()),
    currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    sleep: (duration) => base.sleep(duration),
  };
}

/** The Clock layer `AppLive` mounts when composition injects `now`. */
export function wallClockLayer(now: () => number): Layer.Layer<never> {
  return Layer.effect(Clock.Clock, Clock.clockWith((base) => Effect.succeed(wallClockOverride(now, base))));
}
