import { describe, expect, test } from "bun:test";
import { apiError } from "../helpers/retry";
import { useProcessor, capturingSink, failingStream, streamOf, textEvents, } from "../helpers/processor";
import type { StreamEvent } from "../../src/processor/stream-events";

describe("Processor fold emission", () => {
  const { createProcessor } = useProcessor();
  const failure = () => apiError({ message: "failure fixture", isRetryable: true });

  async function project(chunks: StreamEvent[]) {
    const capture = capturingSink();
    const processor = createProcessor({ sink: capture.sink, createStream: streamOf(chunks) });
    await processor.process({ system: "", promptText: "" });
    return { capture, processor };
  }

  async function twoAttempts(stream: ReturnType<typeof failingStream>) {
    const capture = capturingSink();
    const options = { sink: capture.sink, createStream: stream };
    const failed = createProcessor(options);
    await expect(failed.process({ system: "", promptText: "" })).rejects.toBeInstanceOf(Error);
    expect(capture.messages.at(-1)?.info).toMatchObject({ finish: "error" });
    const processor = createProcessor(options);
    await processor.process({ system: "", promptText: "" });
    expect(stream).toHaveBeenCalledTimes(2);
    return { capture, failed, processor };
  }

  test("preserves separate attempt accounting and paired tool callbacks", async () => {
    const stream = failingStream(
      failure(),
      [{ type: "step-finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 7 } }],
      [
        ...textEvents("retained"),
        { type: "tool-call", toolCallId: "paired", toolName: "lookup", input: {} },
        { type: "tool-result", toolCallId: "paired", toolName: "lookup", output: "42" },
        { type: "step-finish", finishReason: "stop", usage: { inputTokens: 11, outputTokens: 13 } },
      ],
    );
    const { capture, failed, processor } = await twoAttempts(stream);
    expect(capture.messages[0]?.info).toMatchObject({ tokens: { input: 0, output: 0 } });
    const terminals = capture.messages.filter(
      (message) => message.info.role === "assistant" && message.info.finish !== undefined,
    );
    expect(terminals.map((message) => message.info)).toMatchObject([
      { finish: "error", tokens: { input: 5, output: 7 } },
      { finish: "stop", tokens: { input: 11, output: 13 } },
    ]);
    expect(capture.finalParts()).toMatchObject([
      { type: "text", text: "retained" },
      { type: "tool", callID: "paired", state: { status: "completed", output: "42" } },
      { type: "step-finish", tokens: { input: 11, output: 13 } },
    ]);
    expect(capture.toolCalls).toEqual([{ id: "paired", tool: "lookup", input: {} }]);
    expect(capture.toolResults).toMatchObject([{ toolCallId: "paired", content: "42" }]);
    expect(failed.usageTotals).toMatchObject({ input: 5, output: 7 });
    expect(processor.usageTotals).toEqual({
      input: 11,
      output: 13,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
  });

  test("emits only at part boundaries, never per token", async () => {
    const { capture } = await project(textEvents("Hello", " ", "World"));
    expect(capture.textTimeline).toEqual(["", "Hello World", "Hello World"]);
    expect(capture.messages).toHaveLength(3);
  });

  test("later accounting cannot mutate a completed text snapshot", async () => {
    const { capture, processor } = await project([
      ...textEvents("Hello"),
      {
        type: "step-finish",
        finishReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    ]);
    const info = capture.messages[1]?.info;
    if (info?.role !== "assistant") throw new Error("expected assistant info");
    expect(info.finish).toBeUndefined();
    expect(info.tokens.input).toBe(0);
    expect(info.time.completed).toBeUndefined();
    expect(processor.message.finish).toBe("stop");
    expect(processor.message.tokens.input).toBe(10);
  });

  test("failed-attempt parts do not leak into the next attempt", async () => {
    const { capture } = await twoAttempts(
      failingStream(
        failure(),
        [{ type: "text-start" }, { type: "text-delta", text: "draft that must not leak" }],
        textEvents("ok"),
      ),
    );
    expect(
      capture
        .finalParts()
        .filter((part) => part.type === "text")
        .map((part) => part.text),
    ).toEqual(["ok"]);
  });

  test("closes the failed attempt before the next stream starts", async () => {
    const { capture } = await twoAttempts(failingStream(failure(), [{ type: "text-start" }]));
    expect(capture.messages.at(-1)?.info).toMatchObject({ finish: "stop" });
  });

  test("length finish fails incomplete tool calls without salvage", async () => {
    const { capture, processor } = await project([
      { type: "tool-call", toolCallId: "call-cut", toolName: "lookup", input: { q: "x" } },
      { type: "step-finish", finishReason: "length", usage: { inputTokens: 5, outputTokens: 9 } },
    ]);
    expect(capture.finalParts()[0]).toMatchObject({
      type: "tool",
      state: { status: "error", error: "truncated output: tool call incomplete" },
    });
    expect(processor.message.finish).toBe("length");
    expect(capture.toolResults).toMatchObject([{ toolCallId: "call-cut", isError: true }]);
  });

  test.each<{ name: string; chunks: StreamEvent[]; expected: string[] }>([
    {
      name: "orphan delta",
      chunks: [{ type: "text-delta", text: "orphan" }, { type: "text-end" }],
      expected: ["orphan"],
    },
    {
      name: "duplicate end",
      chunks: [...textEvents("once"), { type: "text-end" }],
      expected: ["once"],
    },
    {
      name: "repeated start",
      chunks: [
        { type: "text-start" },
        { type: "text-delta", text: "first" },
        ...textEvents("second"),
      ],
      expected: ["first", "second"],
    },
  ])("normalizes text $name", async ({ chunks, expected }) => {
    const { capture } = await project(chunks);
    expect(
      capture
        .finalParts()
        .filter((part) => part.type === "text")
        .map((part) => part.text),
    ).toEqual(expected);
  });

  test("opens and settles reasoning for an orphan delta", async () => {
    const { capture } = await project([
      { type: "reasoning-delta", id: "orphan", text: "inferred start" },
    ]);
    const part = capture.reasoningParts()[0];
    expect(part?.text).toBe("inferred start");
    expect(part?.time.end).toBeNumber();
  });

  test("ignores a duplicate reasoning end", async () => {
    const { capture } = await project([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "once" },
      { type: "reasoning-end", id: "r1" },
      { type: "reasoning-end", id: "r1" },
    ]);
    expect(capture.finalParts().filter((part) => part.type === "reasoning")).toMatchObject([
      { text: "once" },
    ]);
  });

  test("retains the provider reasoning signature on the completed part", async () => {
    const { capture } = await project([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "thinking" },
      {
        type: "reasoning-delta",
        id: "r1",
        text: "",
        providerMetadata: { anthropic: { signature: "sig-abc" } },
      },
      { type: "reasoning-end", id: "r1" },
    ]);
    expect(capture.finalParts()[0]).toMatchObject({
      type: "reasoning",
      text: "thinking",
      signature: "sig-abc",
    });
  });
});
