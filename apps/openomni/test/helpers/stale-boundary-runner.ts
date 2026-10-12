import type { SessionRunner } from "../../../../packages/agent/src/core/run";
import { Deferred, Effect } from "effect";

/** A held turn that records only messages delivered at its live boundary. */
export function staleBoundaryRunner(
  entered: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
  drained: string[][],
): SessionRunner {
  return (input) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      drained.push((yield* input.boundary("after_tools")).messages.map((message) => message.text));
      return { kind: "result", text: "done" };
    });
}
