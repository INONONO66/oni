import { Effect } from "effect";
import { prepareChatFixture, type ChatFixture } from "./chat-services";
import type { TraceContext } from "@openomni/protocol";
import { createSessionChatRunner } from "../../src/core/session/run";
import { completeModel, type MockLlmFn } from "./mock-llm";

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
