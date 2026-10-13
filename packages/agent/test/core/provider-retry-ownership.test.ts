import { Effect } from "effect";
import { isolated } from "../helpers/isolated";
import { createTestAgent, failure as effectFailure } from "../helpers/effect-g2";
import { afterEach, describe, expect, it } from "bun:test";
import { type FailureFacts, LlmRunFailure, type RunInput, type LlmSink } from "../../src/core/llm";
import type { Model } from "@openomni/protocol";
import { RunEvents } from "../../src/core/turn";
import { Bus } from "../helpers/bus";
import { failureFacts } from "../../src/core/retry";
import { runInput } from "../helpers/run-input";
import { fakeClassifyFailure, FakeProviderError } from "../helpers/fake-llm";
import { createAssistantMessage } from "../../src/core/message-factory";
import { messageSource } from "../helpers/message-source";

/**
 * Retry ownership across the port (#1352): the core schedules every attempt
 * and calls `port.run` exactly once per attempt; the port never retries on
 * its own, and the core reads the failure only through `port.classifyFailure`.
 */
let providerCalls = 0;
let callsByAttempt: number[] = [];
let attempt = 0;
let classified: FailureFacts[] = [];
let providerFailure: (call: number) => Error | undefined = () => undefined;

afterEach(() => Bus.reset());

function providerError(message: string, retryable: boolean): Error {
  return new FakeProviderError({
    message,
    isRetryable: retryable,
    statusCode: retryable ? 529 : 400,
    responseHeaders: retryable ? { "retry-after-ms": "0" } : {},
  });
}

function resetProvider(failure: (call: number) => Error | undefined): void {
  providerCalls = 0;
  callsByAttempt = [];
  attempt = 0;
  classified = [];
  providerFailure = failure;
}

const zeroUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** One port call: one provider attempt, answered by the scripted failure or a completed message. */
function portRun(input: RunInput, sink: LlmSink) {
  return Effect.sync(() => {
    providerCalls += 1;
    if (attempt > 0) callsByAttempt[attempt - 1] = (callsByAttempt[attempt - 1] ?? 0) + 1;
    const cause = providerFailure(providerCalls);
    if (cause !== undefined) {
      return {
        type: "error" as const,
        error: new LlmRunFailure({
          message: cause.message,
          cause,
          providerErrorName: cause.name,
          usage: zeroUsage,
          aborted: false,
          contextOverflow: false,
          visibleOutput: false,
        }),
      };
    }
    sink.onMessage(createAssistantMessage("completed", input.messages.at(-1)?.info.id ?? "", input.trace.sessionId, messageSource));
    return { type: "stop" as const };
  });
}

function createAgent(signal?: AbortSignal) {
  return createTestAgent({
    events: Bus,
    model: { provider: "anthropic", id: "retry-owner-model" },
    auth: { type: "api", key: "test-key" },
    signal,
    llm: {
      run: portRun,
      resolveModel: (model: Model.Ref) =>
        Effect.promise(async () => {
          attempt += 1;
          return { id: model.id, name: model.id, providerID: model.provider };
        }),
      classifyFailure: (facts) => {
        classified.push(facts);
        return fakeClassifyFailure(facts);
      },
    },
  });
}

describe("provider retry ownership", () => {
  it("issues exactly one port call per agent attempt and classifies each failure through the port", async () => {
    let retries = 0;
    const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, () => {
      retries += 1;
    });
    resetProvider((call: number) =>
      call === 1 ? providerError("provider overloaded", true) : undefined,
    );
    try {
      const result = await isolated(
        createAgent().run(runInput([{ role: "user", content: "retry" }])),
      );
      expect(result.finishReason).toBe("stop");
      expect(retries).toBe(1);
      expect(callsByAttempt).toEqual([1, 1]);
      expect(classified).toHaveLength(1);
      expect(classified[0]?.error).toMatchObject({ _tag: "LlmRunFailure", cause: { statusCode: 529 } });
    } finally {
      unsubscribe();
    }
  });

  it("does not call the port for an already-aborted run", async () => {
    resetProvider(() => undefined);
    const controller = new AbortController();
    controller.abort();
    expect(
      await isolated(
        effectFailure(
          createAgent(controller.signal).run(runInput([{ role: "user", content: "abort" }])),
        ),
      ),
    ).toMatchObject({ _tag: "Interrupted" });
    expect(providerCalls).toBe(0);
  });

  it("does not add an agent attempt for a failure the port classifies as terminal", async () => {
    resetProvider(() => providerError("validation failed", false));
    expect(
      await isolated(
        effectFailure(createAgent().run(runInput([{ role: "user", content: "invalid" }]))),
      ),
    ).toMatchObject({ _tag: "LlmRunFailure", cause: { isRetryable: false, statusCode: 400 } });
    expect(callsByAttempt).toEqual([1]);
  });

  it("a retryable failure on every attempt stops at the loop's cap, never at the port", async () => {
    resetProvider(() => providerError("provider overloaded", true));
    const thrown = await isolated(
      effectFailure(createAgent().run(runInput([{ role: "user", content: "keep failing" }]))),
    );
    expect(thrown).toMatchObject({ _tag: "LlmRunFailure" });
    expect(callsByAttempt).toEqual([1, 1, 1]);
    expect(failureFacts(thrown)).toMatchObject({ reason: "server_error", attempt: 3 });
  });
});

function failure(
  overrides: Partial<ConstructorParameters<typeof LlmRunFailure>[0]>,
  cause?: Error,
) {
  return new LlmRunFailure({
    message: "opaque provider failure",
    usage: zeroUsage,
    aborted: false,
    contextOverflow: false,
    visibleOutput: false,
    cause: cause === undefined ? undefined : String(cause),
    ...overrides,
  });
}

async function classifiedRun(providerFailure: LlmRunFailure) {
  let calls = 0;
  const thrown = await isolated(
    effectFailure(
      createTestAgent({
        events: Bus,
        model: { provider: "anthropic", id: "model" },
        llm: {
          resolveModel: () =>
            Effect.promise(async () => ({ id: "model", name: "model", providerID: "anthropic" })),
          run: () =>
            Effect.promise(async () => {
              calls += 1;
              return { type: "error", error: providerFailure };
            }),
        },
      }).run(runInput([{ role: "user", content: "hello" }])),
    ),
  );
  return { calls, thrown };
}

describe("typed provider failure preservation", () => {
  it("preserves abort identity without retry", async () => {
    const providerFailure = failure({ aborted: true, retryAfterMs: 1_234 });
    const result = await classifiedRun(providerFailure);
    expect(result).toEqual({ calls: 1, thrown: providerFailure });
    expect(failureFacts(result.thrown)).toMatchObject({ reason: "aborted", attempt: 1 });
    expect(providerFailure.retryAfterMs).toBe(1_234);
  });

  it("preserves context-overflow cause and usage without blind retry", async () => {
    const cause = new Error("socket closed");
    const usage = { ...zeroUsage, inputTokens: 17, outputTokens: 5 };
    const providerFailure = failure({ contextOverflow: true, usage }, cause);
    const result = await classifiedRun(providerFailure);
    expect(result.calls).toBe(1);
    expect(result.thrown).toBe(providerFailure);
    expect(providerFailure.cause).toBe(String(cause));
    expect(providerFailure.usage).toEqual(usage);
  });
});
