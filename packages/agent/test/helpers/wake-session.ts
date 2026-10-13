import { Effect } from "effect";
import { createController } from "../../src/testing/controller";
import { resolveSessionRuntime, type SessionRunner, type SessionRunnerResult } from "../../src/core/session/run";
import type { SessionError } from "../../src/core/ports/failure";
import type { SessionEntryServices } from "../../src/core/ports/ports";

/**
 * Entity-plane wake (W5.2 F5): one activation adopts the next fence, drains
 * the durable backlog to idle through the same admission machinery, hibernates
 * and closes. Repeated wakes rotate the fence again — exactly what a fresh
 * process activation does; nothing commits on an empty backlog.
 */
export function reactivateSession(
  id: string,
  runner: SessionRunner,
  runtime: Parameters<typeof resolveSessionRuntime>[0],
): Effect.Effect<SessionRunnerResult | undefined, SessionError, SessionEntryServices> {
  return Effect.scoped(
    Effect.gen(function* () {
      const resolved = yield* resolveSessionRuntime(runtime);
      const scope = yield* Effect.scope;
      const controller = yield* createController(runtime.openKernel(id), id, runner, resolved, {
        reactivate: () => Effect.die("wake fixture does not reactivate"),
        release: () => undefined,
      }, scope);
      const result = yield* controller.reconcile();
      yield* controller.handle.close();
      return result;
    }),
  );
}
