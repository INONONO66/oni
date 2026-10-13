import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ProviderEvent } from "../../../src/model/processor/event-schema";
import { useProcessor, capturingSink, processorInfo, streamOf } from "../helpers/processor";
import type { StreamEvent } from "../../../src/model/processor/stream-events";

describe("processor ingress", () => {
  const { createProcessor, events } = useProcessor();

  test.each([
    { type: "text-start", providerMetadata: ["not-an-object"] },
    { type: "tool-call", toolCallId: "bad", toolName: "lookup", input: [1] },
    { type: "tool-result", toolCallId: "bad", isError: "yes" },
    { type: "text-start", id: 42 },
  ])("refuses malformed wire fields %s", (event) => {
    expect(ProviderEvent.safeParse(event).success).toBe(false);
  });

  test("accepts opaque SDK tool output and error values", () => {
    expect(ProviderEvent.safeParse({ type: "tool-result", output: 123n }).success).toBe(true);
    expect(ProviderEvent.safeParse({ type: "tool-result", output: new Date() }).success).toBe(true);
    expect(ProviderEvent.safeParse({ type: "error", error: Symbol("sdk-error") }).success).toBe(true);
  });

  test("a rejected nested payload fails the attempt before projecting", async () => {
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: streamOf([
        { type: "tool-call", toolCallId: "bad", toolName: "lookup", input: {} },
        { type: "tool-result", toolCallId: "bad", output: { output: "x", isError: "yes" } },
      ]),
    });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toMatchObject({
      _tag: "TransportFailure", cause: expect.any(z.ZodError),
    });
    expect(capture.finalParts().filter((part) => part.type === "tool")).toMatchObject([
      { callID: "bad", state: { status: "error", error: "Processing was interrupted" } },
    ]);
    expect(processor.message.finish).toBe("error");
  });

  test("records an iterator close failure and preserves successful settlement", async () => {
    const error = new Error("close fixture");
    const processor = createProcessor({
      createStream: async () => ({
        fullStream: {
          [Symbol.asyncIterator]() {
            return {
              next: async () => ({ done: true as const, value: undefined }),
              return: () => Promise.reject(error),
            };
          },
        },
      }),
    });
    await processor.process({ system: "", promptText: "" });
    expect(processor.message.finish).toBe("stop");
    expect(
      processorInfo(events).filter((event) => event.msg === "stream.close.failed"),
    ).toMatchObject([{ context: { error: "close fixture" } }]);
  });

  test("aborts a text-only stream without waiting for tool settlement", async () => {
    const abort = new AbortController();
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      abort: abort.signal,
      createStream: async () => ({
        fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          yield { type: "text-delta", text: "partial" };
          abort.abort();
          yield { type: "text-end" };
        })(),
      }),
    });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toMatchObject({
      _tag: "TransportFailure", providerErrorName: "AbortError",
    });
    expect(capture.finalParts()).toMatchObject([{ type: "text", text: "partial" }]);
    expect(processor.message.finish).toBe("aborted");
  });

  test("ignores unconsumed text and reasoning wire events", async () => {
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: streamOf([{ type: "text-other" }, { type: "reasoning-other" }]),
    });
    await processor.process({ system: "", promptText: "" });
    expect(capture.finalParts()).toEqual([]);
  });
});
