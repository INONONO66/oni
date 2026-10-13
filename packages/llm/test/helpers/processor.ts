import { beforeEach, mock, type Mock } from "bun:test";
import { Operational, type Message, type Tool } from "@openomni/protocol";
import type { Sink } from "../../src/sink";
import { Processor } from "./native";
import type { StreamEvent } from "../../src/processor/stream-events";
import { collector } from "./observation";
import { anthropicModel, assistantMessage, fixedNow, sequentialIds } from "./fixtures";
import { z } from "zod";

const StatusContext = z.object({
  context: z.object({ stateType: z.string() }),
});

export function streamOf(
  chunks: readonly StreamEvent[],
): Processor.ProcessorOptions["createStream"] {
  return async () => ({
    fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
      yield* chunks;
    })(),
  });
}

export function failingStream(
  error: Error,
  chunks: readonly StreamEvent[] = [],
  next: readonly StreamEvent[] = [{ type: "finish" }],
): Mock<Processor.ProcessorOptions["createStream"]> {
  return mock(streamOf(next)).mockImplementationOnce(async () => ({
    fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
      yield* chunks;
      throw error;
    })(),
  }));
}

export function textEvents(...text: string[]): StreamEvent[] {
  return [
    { type: "text-start" },
    ...text.map((delta) => ({ type: "text-delta", text: delta })),
    { type: "text-end" },
  ];
}

export function capturingSink() {
  const messages: Message.WithParts[] = [];
  const toolCalls: Tool.Call[] = [];
  const toolResults: Tool.Result[] = [];
  const textTimeline: Array<string | undefined> = [];
  const sink: Sink = {
    onMessage(message) {
      messages.push(message);
      textTimeline.push(
        message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))[0],
      );
    },
    onToolCall: (call) => {
      toolCalls.push(call);
    },
    onToolResult: (result) => {
      toolResults.push(result);
    },
  };
  const finalParts = () => messages.at(-1)?.parts ?? [];
  return {
    sink,
    messages,
    toolCalls,
    toolResults,
    textTimeline,
    finalParts,
    /** The final snapshot's parts of one kind, narrowed by discriminant. */
    textParts: () => finalParts().flatMap((part) => (part.type === "text" ? [part] : [])),
    reasoningParts: () => finalParts().flatMap((part) => (part.type === "reasoning" ? [part] : [])),
    toolParts: () => finalParts().flatMap((part) => (part.type === "tool" ? [part] : [])),
    stepFinishParts: () =>
      finalParts().flatMap((part) => (part.type === "step-finish" ? [part] : [])),
  };
}

export function processorInfo(events: ReturnType<typeof collector>) {
  return events
    .named(Operational.Events.Info.name)
    .map((event) => Operational.Events.Info.schema.parse(event))
    .filter((event) => event.component === "llm.processor");
}

export function statusStates(events: ReturnType<typeof collector>): string[] {
  return processorInfo(events)
    .filter((event) => event.msg === "sink.snapshot")
    .map((event) => StatusContext.parse(event).context.stateType);
}

export function useProcessor() {
  const events = collector();
  let message: Message.AssistantMessage;
  let abort: AbortController;
  beforeEach(() => {
    events.reset();
    message = assistantMessage("msg-123", "session-456", "parent-789");
    abort = new AbortController();
  });
  return {
    events,
    get assistantMessage() {
      return message;
    },
    get abortController() {
      return abort;
    },
    createProcessor(
      overrides: Partial<Processor.ProcessorOptions> = {},
    ): ReturnType<typeof Processor.create> {
      return Processor.create({
        assistantMessage: message,
        sessionID: "session-456",
        model: anthropicModel,
        abort: abort.signal,
        events,
        trace: { traceId: "trace-processor-test", sessionId: "session-456" },
        now: fixedNow,
        id: sequentialIds(),
        createStream: streamOf([{ type: "finish" }]),
        ...overrides,
      });
    },
  };
}
