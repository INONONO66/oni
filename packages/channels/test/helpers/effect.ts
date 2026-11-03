import { Effect } from "effect";

/** Runs a channel Effect in tests; all test-side Effect execution is centralized here. */
export function runEffect<A, E>(program: Effect.Effect<A, E, never>): Promise<A>;
export function runEffect<A, E>(program: Effect.Effect<A, E, never>, mode: "sync"): A;
export function runEffect<A, E>(program: Effect.Effect<A, E, never>, mode?: "sync"): A | Promise<A> {
  return mode === "sync" ? Effect.runSync(program) : Effect.runPromise(program);
}

// All test-side Effect execution for this package stays in THIS file (the
// package's named runner account); suites import these helpers instead of
// minting their own runner sites.
import { ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import type { EffectRunner } from "../../src/types";

/**
 * One shared TestClock runtime for driver tests: the returned `run` port is
 * what a test hands the driver under test, and `adjust` moves the fake clock
 * every driver sleep and schedule delay runs on. Dispose in the test's
 * `finally`.
 */
export function testClockRuntime() {
  const runtime = ManagedRuntime.make(TestClock.layer());
  const run: EffectRunner = (effect) => runtime.runPromise(effect);
  return {
    run,
    adjust: (millis: number): Promise<void> => runtime.runPromise(TestClock.adjust(millis)),
    dispose: (): Promise<void> => runtime.dispose(),
  };
}
