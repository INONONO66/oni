import { messageSource } from "../helpers/message-source";
import { recordingResolveModel } from "../helpers/resolve-model";
import { Effect, Fiber } from "effect";
import { isolated } from "../helpers/isolated";
import { createTestAgent, runUserMessage, failure } from "../helpers/effect-g2";
import { describe, expect, it } from "bun:test";
import type { RunInput, LlmSink as Sink } from "../../src/core/ports/llm";
import type { Model } from "@openomni/protocol";
import { RunEvents } from "../../src/core/loop/turn";
import type { RunnerServices } from "../../src/core/ports/ports";
import { createAssistantMessage } from "../../src/core/journal/message-factory";
import { Bus } from "../helpers/bus";
import { createStopOutcome, providerFailure, type MockLlmFn } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";
import { stepSnapshot } from "../helpers/messages";

const primary = { provider: "anthropic", id: "primary-model" };
const fallback = { provider: "openai", id: "fallback-model" };

function fallbackHarness(errorMessage: string) {
  const resolved: Model.Ref[] = [];
  let calls = 0;
  const run: MockLlmFn = async (_input: import("../../src/core/ports/llm").RunInput, sink: Sink) => {
    calls += 1;
    if (calls === 1)
      return {
        type: "error",
        error: providerFailure(
          errorMessage,
          errorMessage === "validation failed"
            ? { retryable: false, statusCode: 400, failureClass: { kind: "terminal", reason: "validation_error", providerReason: "non_retryable", status: 400 } }
            : { failureClass: { kind: "retryable", reason: "transient_error", providerReason: "server_error", afterMs: 0, directed: true, instant: false } },
        ),
      };
    sink.onMessage(createAssistantMessage("recovered", "", "session", messageSource));
    return createStopOutcome();
  };
  return {
    resolved,
    llm: {
      run: (input: RunInput, sink: Sink) => Effect.promise(() => run(input, sink)),
      resolveModel: recordingResolveModel(resolved),
    },
  };
}

function afterFirstRetry<T, E>(operation: () => Effect.Effect<T, E, RunnerServices>): Promise<T> {
  return isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const retry = Promise.withResolvers<void>();
        const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, () => retry.resolve());
        try {
          const running = yield* Effect.forkScoped(operation());
          yield* Effect.promise(() => retry.promise).pipe(Effect.timeout("5 seconds"));
          return yield* Fiber.join(running);
        } finally {
          unsubscribe();
        }
      }),
    ),
  );
}

describe("model fallback via placement", () => {
  for (const scenario of [
    { reason: "transient blip", expected: [primary, fallback] },
    { reason: "tool exploded", expected: [primary, fallback] },
    { reason: "validation failed", expected: [primary, fallback] },
  ]) {
    it(`selects the expected retry model for ${scenario.reason}`, async () => {
      const { resolved, llm } = fallbackHarness(scenario.reason);
      const result = await afterFirstRetry(() =>
        runUserMessage({ events: Bus, model: primary, modelFallbacks: [fallback], llm }, "go"),
      );
      expect(result.finishReason).toBe("stop");
      expect(resolved).toEqual(scenario.expected);
    });
  }

  it("keeps validation failures terminal without a fallback", async () => {
    const { resolved, llm } = fallbackHarness("validation failed");
    expect(
      await isolated(
        failure(
          createTestAgent({ events: Bus, model: primary, llm }).run(
            runInput([{ role: "user", content: "go" }]),
          ),
        ),
      ),
    ).toMatchObject({ _tag: "LlmRunFailure", cause: { isRetryable: false, statusCode: 400 } });
    expect(resolved).toEqual([primary]);
  });

  it("re-arms window yield after switching models", async () => {
    const arms: Array<number | undefined> = [];
    let calls = 0;
    const llm = {
      run: (input: RunInput, sink: Sink) =>
        Effect.sync(() => {
          calls += 1;
          arms.push(input.yieldAtInputTokens);
          if (calls === 1) {
            sink.onMessage(stepSnapshot("first", "working", "tool-calls", 10, 5));
            return createStopOutcome();
          }
          if (calls === 2)
            return { type: "error" as const, error: providerFailure("transient blip", { failureClass: { kind: "retryable", reason: "transient_error", providerReason: "server_error", afterMs: 0, directed: true, instant: false } }) };
          sink.onMessage(stepSnapshot("third", "done", "stop", 10, 5));
          return createStopOutcome();
        }),
      resolveModel: (model: Model.Ref) =>
        Effect.promise(async () => ({
          id: model.id,
          name: model.id,
          providerID: model.provider,
          limit: { context: model.id === primary.id ? 1_000 : 500, output: 1_000 },
        })),
    };
    const result = await afterFirstRetry(() =>
      runUserMessage({ events: Bus, model: primary, modelFallbacks: [fallback], llm }, "go"),
    );
    expect(result.finishReason).toBe("stop");
    expect(arms).toEqual([450, undefined, 225]);
  });
});
