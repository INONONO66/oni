import { describe, expect, test } from "bun:test";
import { useProcessor, capturingSink, streamOf, textEvents } from "../helpers/processor";

describe("Processor processor", () => {
  const fixture = useProcessor();
  const { createProcessor } = fixture;

  test("exposes the assistant message and a process method", () => {
    const processor = createProcessor();

    expect(processor.message).toBe(fixture.assistantMessage);
    expect(typeof processor.process).toBe("function");
  });

  test("fails loudly when generated part identities collide", async () => {
    // The injected id source is the collision vector: a constant id makes the
    // second step-start fold reject.
    const processor = createProcessor({
      id: () => "00000000-0000-4000-8000-000000000000",
      createStream: streamOf([
        { type: "step-start" },
        { type: "step-start" },
        { type: "finish" },
      ]),
    });

    await expect(processor.process({ system: "", promptText: "" })).rejects.toThrow(
      "transcript recording defect",
    );
  });

  test("projects text events into a completed TextPart", async () => {
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: streamOf(textEvents("Hello")),
    });

    await processor.process({ system: "", promptText: "" });

    const textPart = capture.textParts()[0];
    expect(textPart?.text).toBe("Hello");
    expect(textPart?.time?.start).toBeNumber();
    expect(textPart?.time?.end).toBeNumber();
    expect(processor.message.time.completed).toBeNumber();
  });

  test("ignores fullStream events that do not project into transcript parts", async () => {
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: streamOf([
        { type: "tool-input-start", id: "tool-input-1", toolName: "read" },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    expect(capture.finalParts()).toEqual([]);
    expect(processor.message.time.completed).toBeNumber();
  });

  test("delivers the full text at part boundaries instead of per delta", async () => {
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: streamOf(textEvents("Hello", " ", "World")),
    });

    await processor.process({ system: "", promptText: "" });

    // Boundary snapshots only: open part, completed part with the
    // full text, message.finished. Deltas emit nothing through onMessage.
    expect(capture.textTimeline).toEqual(["", "Hello World", "Hello World"]);
  });

  test("projects reasoning events into a ReasoningPart with timing", async () => {
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: streamOf([
        { type: "reasoning-start", id: "r1", providerMetadata: {} },
        { type: "reasoning-delta", id: "r1", text: "Step 1" },
        { type: "reasoning-delta", id: "r1", text: " - " },
        { type: "reasoning-delta", id: "r1", text: "Step 2" },
        { type: "reasoning-end", id: "r1", providerMetadata: {} },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const reasoningPart = capture.reasoningParts()[0];
    expect(reasoningPart?.text).toBe("Step 1 - Step 2");
    expect(reasoningPart?.time.start).toBeNumber();
    expect(reasoningPart?.time.end).toBeNumber();
  });

  test("projects step-start and step-finish events as parts", async () => {
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: streamOf([
        { type: "step-start" },
        {
          type: "step-finish",
          finishReason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            reasoning_tokens: 4,
            cache_creation_input_tokens: 6,
            cache_read_input_tokens: 2,
          },
          providerMetadata: {},
        },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const types = capture.finalParts().map((part) => part.type);
    expect(types).toEqual(["step-start", "step-finish"]);
    // Provider finish maps into the transcript vocabulary; the raw provider
    // string survives on the step-finish part.
    expect(processor.message.finish).toBe("stop");
    const stepFinish = capture.stepFinishParts()[0];
    expect(stepFinish?.reason).toBe("end_turn");
    expect(processor.message.tokens).toEqual({
      input: 10,
      output: 20,
      reasoning: 4,
      cache: { read: 2, write: 6 },
    });
  });

  test("trims trailing whitespace from text and reasoning at block end", async () => {
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: streamOf([
        { type: "text-start", providerMetadata: {} },
        { type: "text-delta", text: "Hello   " },
        { type: "text-end", providerMetadata: {} },
        { type: "reasoning-start", id: "r1", providerMetadata: {} },
        { type: "reasoning-delta", id: "r1", text: "thinking   " },
        { type: "reasoning-end", id: "r1", providerMetadata: {} },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const textPart = capture.textParts()[0];
    const reasoningPart = capture.reasoningParts()[0];
    expect(textPart?.text).toBe("Hello");
    expect(reasoningPart?.text).toBe("thinking");
  });

  test("handles multiple sequential text blocks as separate parts", async () => {
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: streamOf([
        { type: "text-start", providerMetadata: {} },
        { type: "text-delta", text: "First" },
        { type: "text-end", providerMetadata: {} },
        { type: "text-start", providerMetadata: {} },
        { type: "text-delta", text: "Second" },
        { type: "text-end", providerMetadata: {} },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const textParts = capture.textParts();
    expect(textParts.map((part) => part.text)).toEqual(["First", "Second"]);
  });

  test("ignores duplicate reasoning-start events with same id", async () => {
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: streamOf([
        { type: "reasoning-start", id: "r1", providerMetadata: {} },
        { type: "reasoning-start", id: "r1", providerMetadata: {} },
        { type: "reasoning-delta", id: "r1", text: "test" },
        { type: "reasoning-end", id: "r1", providerMetadata: {} },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const reasoningParts = capture.reasoningParts();
    expect(reasoningParts).toHaveLength(1);
    expect(reasoningParts[0]?.text).toBe("test");
  });

  test("settles unresolved tool calls when the stream ends cleanly", async () => {
    // isStepCount can stop the stream after tool-call events whose results
    // will never arrive; those parts must not stay pending forever.
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: streamOf([
        { type: "tool-call", toolCallId: "call-orphan", toolName: "lookup", input: { q: "x" } },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const toolPart = capture.toolParts()[0];
    expect(toolPart?.state.status).toBe("error");
    expect(capture.toolResults).toHaveLength(1);
    expect(capture.toolResults[0]).toMatchObject({
      toolCallId: "call-orphan",
      content: "Processing was interrupted",
      isError: true,
    });
  });
});
