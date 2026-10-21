import { Effect, Scope } from "effect";
import { AppScope } from "../runtime";

export function bootResource<A, E, R, E2, R2>(
  acquire: Effect.Effect<A, E, R>,
  release: (value: A) => Effect.Effect<void, E2, R2>,
): Effect.Effect<A, E, R | R2 | AppScope> {
  return Effect.flatMap(AppScope, (scope) =>
    Effect.acquireRelease(acquire, (value) => release(value).pipe(Effect.orDie)).pipe(
      Scope.provide(scope),
    ),
  );
}
