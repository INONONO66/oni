import { Effect } from "effect";
import { prepareChatFixture, type ChatFixture } from "./chat-services";
import type { TraceContext } from "@openomni/protocol";
import { createSessionChatRunner } from "../../src/core/session/run";
import { session } from "../../src/testing/registry";
import { fixtureConfigHead, fixtureTraceContext } from "./chat-services";
import { completeModel, mockLlm, type MockLlmFn } from "./mock-llm";
import { testTurnDispatcher } from "./service-layers";
import { type silentRuntime, withSessionServices } from "./session-services";

type Prepared = Effect.Success<ReturnType<Parameters<typeof createSessionChatRunner>[0]["prepare"]>>;

export function recordingChatRunner(config: (run: MockLlmFn) => ChatFixture & Pick<Prepared["config"], "executor">, traceContext: TraceContext.Type) {
  const modelInputs: string[] = [];
  const runner = createSessionChatRunner({
    prepare: () => Effect.gen(function* () { return prepareChatFixture(({
      config: config(async (input, sink) => {
        modelInputs.push(JSON.stringify(input.messages));
        return completeModel(input, sink);
      }),
      traceContext,
    })); }),
  });
  return { runner, modelInputs };
}

/** A resident session whose turns run the completing mock model through the test dispatcher. */
export function completingChatSession(id: string, runtime: ReturnType<typeof silentRuntime>) {
  const runner = createSessionChatRunner({
    prepare: (input) => Effect.gen(function* () {
      const dispatcher = yield* testTurnDispatcher(input, runtime);
      return prepareChatFixture({
        traceContext: fixtureTraceContext(input),
        config: { ...fixtureConfigHead(dispatcher.executor), llm: mockLlm(completeModel) },
      });
    }),
  });
  return withSessionServices(session({ id, role: "resident", runner }, runtime), runtime);
}
