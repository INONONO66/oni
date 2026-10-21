import { type Effect, Exit, Scope } from "effect";
import { runEffect, runSyncEffect } from "./effect";

/** A resource scope kept alive across imperative test actions. */
export function effectScope() {
  const scope = runSyncEffect(Scope.make());
  return {
    scope,
    runSync<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A {
      return runSyncEffect(Scope.provide(effect, scope));
    },
    run<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> {
      return runEffect(Scope.provide(effect, scope));
    },
    close: () => runEffect(Scope.close(scope, Exit.void)),
  };
}
