import { Deferred, Effect } from "effect";
import type { Exit } from "effect";
import type { ArmVerb } from "../../src/core/ports/alarm";
import { sendPrompt } from "./cluster-runtime";

export function sendPromptAndGetArm(
  sessionId: string,
  live: { readonly live: (sessionId: string) => Effect.Effect<ArmVerb, never, never> },
) {
  return Effect.gen(function* () {
    yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
    return yield* live.live(sessionId);
  });
}

export type ArmExit = Exit.Exit<Effect.Success<ReturnType<ArmVerb>>, Effect.Error<ReturnType<ArmVerb>>>;

export function forkArm(
  arm: ArmVerb,
  input: Parameters<ArmVerb>[0],
  done: Deferred.Deferred<ArmExit>,
): Effect.Effect<void> {
  return Effect.forkChild(
    arm(input).pipe(
      Effect.exit,
      Effect.flatMap((exit) => Deferred.succeed(done, exit)),
    ),
  ).pipe(Effect.asVoid);
}
