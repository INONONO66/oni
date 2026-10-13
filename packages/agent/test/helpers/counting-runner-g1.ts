import { testTurnDispatcher } from "./service-layers";
import { fixtureConfigHead, fixtureTraceContext, prepareChatFixture } from "./chat-services";
import type { SessionFixture as SessionRuntime } from "./session-services";
import { Effect } from "effect";
import type { RunInput, LlmSink as Sink } from "../../src/core/llm";
import type { SessionRunnerInput, SessionRunner } from "../../src/core/run";
import { createSessionChatRunner } from "../../src/core/run";
import type { ExecutionError } from "../../src/core/failure";
import { completeModel } from "./mock-llm";

/** A real session chat runner with an Effect-native model-entry barrier. */
export function countingRunner(
  runtime: SessionRuntime,
  calls: { model: number },
  onModel: () => Effect.Effect<void, ExecutionError> = () => Effect.void,
): SessionRunner {
  return createSessionChatRunner({
    prepare: (input: SessionRunnerInput) =>
      Effect.gen(function* () {
        const dispatcher = yield* testTurnDispatcher(input, runtime);
        return prepareChatFixture({
          traceContext: fixtureTraceContext(input),
          config: {
            ...fixtureConfigHead(dispatcher.executor),
            llm: {
              resolveModel: () => Effect.succeed({ providerID: "test", id: "test", name: "test" }),
              run: (request: RunInput, sink: Sink) =>
                Effect.gen(function* () {
                  // A failed test barrier is a defect, not a retryable provider failure.
                  yield* onModel().pipe(Effect.orDie);
                  calls.model += 1;
                  return yield* Effect.promise(() => completeModel(request, sink));
                }),
            },
          },
        });
      }),
  });
}
