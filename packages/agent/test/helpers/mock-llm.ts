import { messageSource } from "./message-source";
import type { ChatFixture as ChatAgentConfig } from "./chat-services";
import { LlmRunFailure, type FailureClass, type LlmSink as Sink, type RunInput, type RunResult } from "../../src/core/ports/llm";
import { Effect } from "effect";
import type {} from "../../src/core/ports/types";
import { createAssistantMessage } from "../../src/core/journal/message-factory";
import { FakeProviderError, fakeClassifyFailure, fakeResolvedModel } from "./fake-llm";

export type MockLlmFn = (input: RunInput, sink: Sink) => Promise<RunResult>;

// Explicit terminal provider behavior, never injected into another mock's output.
export const completeModel: MockLlmFn = async (input, sink) => {
  sink.onMessage(
    createAssistantMessage("done", input.messages.at(-1)?.info.id ?? "", input.trace.sessionId, messageSource),
  );
  return { type: "stop" };
};

export function createStopOutcome(): RunResult {
  return { type: "stop" };
}

export function countingStopLlm() {
  let calls = 0;
  return {
    get calls() { return calls; },
    llm: mockLlm(async () => {
      calls += 1;
      return createStopOutcome();
    }),
  };
}

export function providerFailure(
  message: string,
  options: {
    retryable?: boolean;
    statusCode?: number;
    contextOverflow?: boolean;
    aborted?: boolean;
    failureClass?: FailureClass;
  } = {},
): LlmRunFailure {
  const cause = new FakeProviderError({
    message,
    statusCode: options.statusCode ?? 529,
    responseHeaders: { "retry-after-ms": "0" },
    isRetryable: options.retryable ?? true,
    failureClass: options.failureClass,
  });
  return new LlmRunFailure({
      cause,
      providerErrorName: cause.name,
      retryAfterMs: 0,
      message,
      aborted: options.aborted ?? false,
      contextOverflow: options.contextOverflow ?? false,
      visibleOutput: false,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
  });
}

export const mockProviderModel = fakeResolvedModel;

/** An llm config whose resolved "provider/model" advertises a `context`-token window. */
export function windowedLlm(run: MockLlmFn, context = 1000): ChatAgentConfig["llm"] {
  return {
    resolveModel: () => Effect.succeed({
      id: "model",
      name: "model",
      providerID: "provider",
      limit: { context, output: 100 },
    }),
    run: (input, sink) => Effect.promise(() => run(input, sink)),
    classifyFailure: fakeClassifyFailure,
  };
}

/** The port fake resolving to the anthropic haiku fixture with `run` as its provider behavior. */
export function mockLlm(run: MockLlmFn): NonNullable<ChatAgentConfig["llm"]> {
  return {
    resolveModel: () => Effect.succeed(mockProviderModel),
    run: (input, sink) => Effect.promise(() => run(input, sink)),
    classifyFailure: fakeClassifyFailure,
  };
}
