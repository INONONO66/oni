import type { RunInput, LlmSink as Sink } from "../../src/core/ports/llm";
import { isolated } from "../helpers/isolated";
import { failure } from "../helpers/g0-signals";
import { providerFailure } from "../helpers/mock-llm";
import { createTestAgent } from "../helpers/g0-effect";
import { describe, expect, it } from "bun:test";
import { assistantTextSnapshot } from "../helpers/messages";
import { Bus } from "../helpers/bus";
import { mockLlm, createStopOutcome, type MockLlmFn } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";

function agent(run: MockLlmFn) {
  return createTestAgent({
    events: Bus,
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    llm: mockLlm(run),
  });
}

describe("run terminal message result contract", () => {
  it.each([
    [0, 7],
    [11, 0],
  ])("preserves asymmetric snapshot usage %i/%i", async (input: number, output: number) => {
    const result = await isolated(
      agent(async (_input: RunInput, sink: Sink) => {
        sink.onMessage(assistantTextSnapshot("counted", input, output));
        return createStopOutcome();
      }).run(runInput([{ role: "user", content: "count" }])),
    );
    expect(result.usage).toMatchObject({
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
    });
  });
  it("returns stop, text, steps, and usage from the terminal assistant snapshot", async () => {
    const result = await isolated(
      agent(async (_input: RunInput, sink: Sink) => {
        sink.onMessage(assistantTextSnapshot("the answer is 42", 20, 10));
        return createStopOutcome();
      }).run(runInput([{ role: "user", content: "hello" }])),
    );
    expect(result).toMatchObject({
      finishReason: "stop",
      text: "the answer is 42",
      steps: [{ type: "text", content: "the answer is 42" }],
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    });
  });

  it("charges cumulative billed usage while retaining the final model's context snapshot", async () => {
    const result = await isolated(
      agent(async (_input: RunInput, sink: Sink) => {
        sink.onMessage(assistantTextSnapshot("answer", 10, 5));
        return { type: "stop", billedUsage: {
          inputTokens: 110, outputTokens: 45, reasoningTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0,
        } };
      }).run(runInput([{ role: "user", content: "count" }])),
    );
    expect(result.usage).toMatchObject({ inputTokens: 110, outputTokens: 45, totalTokens: 155 });
  });

  it("reports a budget error without calling the provider when the turn budget is zero", async () => {
    let calls = 0;
    const configured = createTestAgent({
      events: Bus,
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      budget: { maxTurns: 0 },
      llm: mockLlm(async () => {
        calls += 1;
        return createStopOutcome();
      }),
    });
    expect(
      await isolated(failure(configured.run(runInput([{ role: "user", content: "hello" }])))),
    ).toMatchObject({ code: "agent_stop", reason: "budget" });
    expect(calls).toBe(0);
  });

  it("propagates a terminal validation error", async () => {
    expect(
      await isolated(
        failure(
          agent(async () => ({
            type: "error",
            error: providerFailure("validation failed", { retryable: false, statusCode: 400, failureClass: { kind: "terminal", reason: "validation_error", providerReason: "non_retryable", status: 400 } }),
          })).run(runInput([{ role: "user", content: "hello" }])),
        ),
      ),
    ).toMatchObject({ _tag: "LlmRunFailure", cause: { statusCode: 400, isRetryable: false } });
  });
});
