import { describe, expect, test } from "bun:test";
import { LlmCall, Operational, type BusEvent, type Message, type Tool } from "@openomni/protocol";
import { z } from "zod";
import type { Sink } from "../../src/sink";
import { apiError } from "../helpers/retry";
import { useProcessor, streamOf, statusStates, processorInfo } from "../helpers/processor";

describe("Processor telemetry", () => {
  const fixture = useProcessor();
  const { createProcessor, events } = fixture;

  test("publishes exactly one busy and one idle status on success", async () => {
    const processor = createProcessor();

    await processor.process({ system: "", promptText: "" });

    expect(statusStates(events)).toEqual(["busy", "idle"]);
  });

  test("publishes idle before a microtask queued by message.finished", async () => {
    const order: string[] = [];
    const IdleContext = z.object({ context: z.object({ stateType: z.literal("idle") }) });
    const orderedEvents: BusEvent.Sink = {
      publish(event, data) {
        if (event.name !== Operational.Events.Info.name) return;
        if (IdleContext.safeParse(data).success) order.push("idle");
      },
    };
    const processor = createProcessor({
      events: orderedEvents,
      sink: {
        onMessage(message) {
          if ("completed" in message.info.time && message.info.time.completed !== undefined) {
            order.push("finish");
            queueMicrotask(() => order.push("queued"));
          }
        },
        onToolCall: () => undefined,
        onToolResult: () => undefined,
      },
    });

    await processor.process({ system: "", promptText: "" });

    expect(order).toEqual(["finish", "idle", "queued"]);
  });

  test("projects sink callbacks onto the events port", async () => {
    const sinkEvents: string[] = [];
    const toolCalls: Tool.Call[] = [];
    const toolResults: Tool.Result[] = [];
    const messages: Message.WithParts[] = [];

    const sink: Sink = {
      onMessage(message) {
        sinkEvents.push("message");
        messages.push(message);
      },
      onToolCall(call) {
        sinkEvents.push("toolCall");
        toolCalls.push(call);
      },
      onToolResult(result) {
        sinkEvents.push("toolResult");
        toolResults.push(result);
      },
    };

    const processor = createProcessor({
      sink,
      trace: { traceId: "trace-projection", sessionId: "session-456" },
      createStream: streamOf([
        { type: "text-start", providerMetadata: {} },
        { type: "text-delta", text: "Hello" },
        { type: "text-end", providerMetadata: {} },
        { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: { q: "x" } },
        { type: "tool-result", toolCallId: "call-1", toolName: "lookup", output: "ok" },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    expect(sinkEvents).toContain("message");
    expect(sinkEvents).toContain("toolCall");
    expect(sinkEvents).toContain("toolResult");
    expect(messages.length).toBeGreaterThan(0);
    expect(toolCalls).toEqual([{ id: "call-1", tool: "lookup", input: { q: "x" } }]);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.toolCallId).toBe("call-1");

    const infoEvents = processorInfo(events);
    expect(infoEvents.every((event) => event.component === "llm.processor")).toBe(true);
    expect(infoEvents.every((event) => event.sessionId === "session-456")).toBe(true);
    // sink.* diagnostics must join to llm.call.* events via the run traceId.
    expect(infoEvents.every((event) => event.traceId === "trace-projection")).toBe(true);
    expect(infoEvents.every((event) => typeof event.time === "number")).toBe(true);

    const messageEvents = infoEvents.filter((event) => event.msg === "sink.message");
    const snapshotEvents = infoEvents.filter((event) => event.msg === "sink.snapshot");
    const toolStarted = infoEvents.find((event) => event.msg === "sink.tool.started");
    const toolCompleted = infoEvents.find((event) => event.msg === "sink.tool.completed");
    const ToolStartedContext = z.object({
      toolCallId: z.literal("call-1"),
      toolName: z.literal("lookup"),
      inputSummary: z.literal("q"),
    });
    const ToolCompletedContext = z.object({
      toolCallId: z.literal("call-1"),
      outputLength: z.literal(2),
    });

    expect(messageEvents.length).toBe(messages.length);
    expect(snapshotEvents.length).toBe(2);
    expect(ToolStartedContext.parse(toolStarted?.context)).toEqual({
      toolCallId: "call-1",
      toolName: "lookup",
      inputSummary: "q",
    });
    expect(ToolCompletedContext.parse(toolCompleted?.context)).toEqual({
      toolCallId: "call-1",
      outputLength: 2,
    });
  });

  test("published part snapshots are frozen at publish time", async () => {
    // Retained snapshots must not change when later deltas arrive.
    const snapshots: Message.WithParts[] = [];
    const sink: Sink = {
      onMessage: (message) => snapshots.push(message),
      onToolCall: () => undefined,
      onToolResult: () => undefined,
    };

    const processor = createProcessor({
      sink,
      createStream: streamOf([
        { type: "text-start", providerMetadata: {} },
        { type: "text-delta", text: "Hello" },
        { type: "text-delta", text: " World" },
        { type: "text-end", providerMetadata: {} },
        { type: "finish" },
      ]),
    });

    await processor.process({ system: "", promptText: "" });

    const textAt = (index: number) =>
      snapshots[index]?.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))[0];
    // Boundary snapshots: the open part stays empty in the first snapshot
    // even after the part later completed with the full text.
    expect(textAt(0)).toBe("");
    expect(textAt(1)).toBe("Hello World");
  });

  test("leaves retry publication to the executor and closes a rate-limited attempt", async () => {
    const error = apiError({ message: "rate limit", isRetryable: true, statusCode: 429 });
    const processor = createProcessor({
      createStream: async () => {
        throw error;
      },
    });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toBe(error);
    expect(events.named(LlmCall.Events.RetryDecided.name)).toEqual([]);
    expect(events.named(LlmCall.Events.RateLimited.name)).toEqual([]);
    expect(statusStates(events)).toEqual(["busy", "idle"]);
  });
});
