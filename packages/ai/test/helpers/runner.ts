import { Effect, type Exit } from "effect";

/** The package's only Effect runners: tests execute native effects through these two edges. */
export function runTestSync<A, E>(program: Effect.Effect<A, E>): A {
  return Effect.runSync(program);
}

export function runTestExit<A, E>(program: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(program);
}
