import { describe, expect, mock, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { LlmCall } from "@oni/protocol";
import { Processor as NativeProcessor } from "../../src/processor";
import { anthropicModel, fixedNow, sequentialIds } from "../helpers/fixtures";
import { runEffect } from "../helpers/native";

import { apiError, sdkError } from "../helpers/retry";
import { decodeLlmFailure } from "../../src/error";
import { useProcessor, capturingSink, failingStream, statusStates } from "../helpers/processor";
import type { StreamEvent } from "../../src/processor/stream-events";

describe("Processor failures", () => {
  test("settles an interrupted attempt and publishes an aborted finish", async () => {
    const entered = Promise.withResolvers<void>();
    const processor = NativeProcessor.create({
      assistantMessage: fixture.assistantMessage,
      sessionID: "session-456",
      model: anthropicModel,
      abort: fixture.abortController.signal,
      events,
      now: fixedNow,
      id: sequentialIds(),
      trace: { traceId: "interrupt", sessionId: "session-456" },
      createStream: () => Effect.sync(() => {
        entered.resolve();
      }).pipe(Effect.andThen(Effect.never)),
    });
    const fiber = await runEffect(Effect.forkDetach(processor.process({ system: "", promptText: "" })));
    await runEffect(Effect.promise(() => entered.promise).pipe(Effect.timeout("5 seconds")));
    await runEffect(Fiber.interrupt(fiber).pipe(Effect.timeout("5 seconds")));
    expect(processor.message.finish).toBe("aborted");
    expect(statusStates(events)).toEqual(["busy", "idle"]);
  });

  const fixture = useProcessor();
  const { createProcessor, events } = fixture;

  test("settles the failed attempt's tool calls before surfacing the failure", async () => {
    const error = apiError({ message: "failure fixture", isRetryable: true });
    const stream = failingStream(error, [
      { type: "tool-call", toolCallId: "call-attempt-1", toolName: "lookup", input: {} },
    ]);
    const capture = capturingSink();
    const processor = createProcessor({ sink: capture.sink, createStream: stream });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(capture.finalParts()).toMatchObject([{ type: "tool", state: { status: "error" } }]);
    expect(capture.toolResults).toMatchObject([{ toolCallId: "call-attempt-1", isError: true }]);
  });

  test("a synchronous provider refusal settles without scheduling another attempt", async () => {
    const error = apiError({
      message: "failure fixture",
      isRetryable: true,
      responseHeaders: { "retry-after-ms": "0" },
    });
    const stream = mock(() => {
      throw error;
    });
    const processor = createProcessor({ createStream: stream });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(statusStates(events)).toEqual(["busy", "idle"]);
  });

  test("respects an already-aborted signal", async () => {
    const processor = createProcessor();
    fixture.abortController.abort();
    await expect(processor.process({ system: "", promptText: "" })).rejects.toMatchObject({
      _tag: "TransportFailure", providerErrorName: "AbortError",
    });
  });

  test("classifies a custom-reason abort as aborted, not error", async () => {
    const reason = new Error("abort fixture");
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: async () => ({
        fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          yield { type: "tool-call", toolCallId: "call-abort", toolName: "lookup", input: {} };
          fixture.abortController.abort(reason);
          yield { type: "text-start" };
        })(),
      }),
    });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toMatchObject({ _tag: "TransportFailure", cause: reason });
    expect(processor.message.finish).toBe("aborted");
    expect(capture.finalParts()).toMatchObject([
      { type: "tool", state: { status: "error", error: "interrupted" } },
    ]);
  });

  test("retains inferred-reset failure for the executor without owning backoff", async () => {
    const error = apiError({
      message: "failure fixture",
      isRetryable: true,
      statusCode: 429,
      responseHeaders: { "anthropic-ratelimit-requests-reset": "120s" },
    });
    const processor = createProcessor({ createStream: failingStream(error) });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
    expect(events.named(LlmCall.Events.RetryDecided.name)).toEqual([]);
    expect(processor.message.finish).toBe("error");
  });

  test.each([
    sdkError({
      message: "SDK fixture",
      isRetryable: true,
      statusCode: 529,
      responseHeaders: { "Retry-After-Ms": "1" },
    }),
    apiError({
      message: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }),
      isRetryable: true,
    }),
  ])("propagates %s after exactly one attempt", async (error) => {
    const stream = failingStream(error);
    const processor = createProcessor({ createStream: stream });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toMatchObject({ _tag: "APIError", message: error.message, cause: { isRetryable: true } });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  test("preserves the Anthropic 429 identity for canonical classification", async () => {
    const error = apiError({
      message: JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }),
      statusCode: 429,
      isRetryable: true,
      responseHeaders: { "retry-after-ms": "1" },
    });
    const processor = createProcessor({ createStream: failingStream(error) });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
    expect(processor.message.finish).toBe("error");
  });

  test("throws the original non-retryable error and settles its tool once", async () => {
    const error = apiError({ message: "failure fixture", statusCode: 500, isRetryable: false });
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: failingStream(error, [
        { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: {} },
      ]),
    });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
    expect(statusStates(events)).toEqual(["busy", "idle"]);
    expect(capture.toolResults).toMatchObject([
      { toolCallId: "call-1", content: "Processing was interrupted", isError: true },
    ]);
    expect(capture.finalParts()).toMatchObject([{ type: "tool", state: { status: "error" } }]);
  });

  // A model-boundary throw keeps its structured cause — the original
  // Error object rides TransportFailure.cause; nothing flattens to a string.
  test("a plain thrown Error becomes a TransportFailure carrying the structured cause", () => {
    const thrown = new Error("socket hangup");
    const decoded = decodeLlmFailure("provider.stream")(thrown);
    expect(decoded).toMatchObject({
      _tag: "TransportFailure",
      operation: "provider.stream",
      message: "socket hangup",
      providerErrorName: "Error",
    });
    expect(decoded._tag === "TransportFailure" ? decoded.cause : undefined).toBe(thrown);
  });

  // The SDK call error still arrives as the structured APIError wrapper,
  // with the APICallError itself as the nested cause, never a rendering of it.
  test("an SDK call error decodes to APIError whose cause IS the APICallError", () => {
    const callError = sdkError({ message: "upstream 500", statusCode: 500, isRetryable: false });
    const decoded = decodeLlmFailure("provider.stream")(callError);
    expect(decoded._tag).toBe("APIError");
    expect(decoded._tag === "APIError" ? decoded.cause : undefined).toBe(callError);
  });
});
