import { describe, expect, test } from "bun:test";
import { LlmCall } from "../src/event/llm.js";

describe("LlmCall BusEvents", () => {
  const base = { traceId: "test-trace-id", sessionId: "s1", time: Date.now() };

  function parseCompleted<Input>(input: Input) {
    return LlmCall.Events.Completed.schema.parse(input);
  }

  test("Completed refuses missing token lanes — the producer states them", () => {
    const completed = {
      ...base,
      provider: "openai",
      model: "gpt-4o",
      durationMs: 100,
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 7,
      cacheReadTokens: 90,
      cacheWriteTokens: 3,
      finishReason: "stop",
    };
    expect(LlmCall.Events.Completed.schema.parse(completed)).toMatchObject({
      reasoningTokens: 7,
      cacheReadTokens: 90,
      cacheWriteTokens: 3,
    });
    // Pin: a defaulted zero is indistinguishable from "provider reported no
    // reasoning tokens" — a producer that drops a lane must fail, not zero.
    const { reasoningTokens: _r, ...missing } = completed;
    expect(LlmCall.Events.Completed.schema.safeParse(missing).success).toBe(false);
    expect(LlmCall.Events.Completed.name).toBe("llm.call.completed");
  });

  test("Failed refuses a missing aborted flag — false is load-bearing", () => {
    const failed = {
      ...base,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      durationMs: 42,
      error: "No authentication found",
    };
    // Pin: a dropped field must not silently read as "genuine error".
    expect(LlmCall.Events.Failed.schema.safeParse(failed).success).toBe(false);
    expect(LlmCall.Events.Failed.schema.parse({ ...failed, aborted: true })).toMatchObject({
      aborted: true,
    });
    expect(LlmCall.Events.Failed.name).toBe("llm.call.failed");
  });

  test("TranscriptionCompleted carries the call's trace and byte count without session identity", () => {
    const row = { traceId: "test-trace-id", time: 10, provider: "openai", model: "gpt-4o-transcribe", inputBytes: 7, durationMs: 250 };
    expect(LlmCall.Events.TranscriptionCompleted.schema.parse(row)).toEqual(row);
    expect(LlmCall.Events.TranscriptionCompleted.name).toBe("llm.transcription.completed");
    expect(LlmCall.Events.TranscriptionCompleted.visibility).toBe("llm_reason");
    for (const malformed of [
      { ...row, inputBytes: -1 },
      { ...row, inputBytes: 1.5 },
      { ...row, provider: undefined },
      { ...row, traceId: undefined },
    ]) {
      expect(LlmCall.Events.TranscriptionCompleted.schema.safeParse(malformed).success).toBe(false);
    }
  });

  test("Completed rejects negative and fractional token counts", () => {
    const valid = {
      ...base,
      provider: "openai",
      model: "gpt-4o",
      durationMs: 100,
      outputTokens: 50,
      finishReason: "stop",
    };

    expect(() => parseCompleted({ ...valid, inputTokens: -1 })).toThrow();
    expect(() => parseCompleted({ ...valid, inputTokens: 1.5 })).toThrow();
  });
});
