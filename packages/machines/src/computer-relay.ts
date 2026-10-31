import type { Machine } from "@oni/protocol";
import { Deferred, Effect, Exit } from "effect";

export class ComputerRelay {
  private readonly closed = Deferred.makeUnsafe<void>();
  private ended = false;

  close(): void {
    this.ended = true;
    Deferred.doneUnsafe(this.closed, Exit.void);
  }

  run<A, E>(body: Effect.Effect<A, E>): Effect.Effect<A | Machine.ComputerCancelled, E> {
    const cancelled: Machine.ComputerCancelled = {
      status: "unverifiable", reason: "cancelled", dispatched: "unknown", hint: "re_observe",
    };
    return Effect.suspend(() => this.ended ? Effect.succeed(cancelled) :
      Effect.raceFirst(body, Deferred.await(this.closed).pipe(Effect.as(cancelled))).pipe(
        Effect.map((result) => this.ended ? cancelled : result),
        Effect.catch((error) => this.ended ? Effect.succeed(cancelled) : Effect.fail(error)),
      ));
  }
}
