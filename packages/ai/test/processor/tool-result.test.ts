import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Message, Tool } from "@oni/protocol";
import type { Sink } from "../../src/sink";
import { Bus } from "../helpers/observation";
import { useProcessor, capturingSink } from "../helpers/processor";
const { createProcessor } = useProcessor();
import type { StreamEvent } from "../../src/processor/stream-events";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type ToolProjectionCase = {
  readonly name: string;
  readonly chunks: readonly StreamEvent[];
  readonly toolNames?: ReadonlyMap<string, string>;
  readonly expectedCalls?: Tool.Call[];
  readonly expectedResults?: number;
  readonly expectedResult?: Partial<Tool.Result>;
  readonly expectedPart: {
    readonly callID: string;
    readonly tool?: string;
    readonly state: Partial<Tool.State>;
  };
};

const toolProjectionCases: ToolProjectionCase[] = [
  {
    name: "restores dotted internal names through the reverse map",
    toolNames: new Map([["message_send", "message.send"]]),
    chunks: [
      {
        type: "tool-call",
        toolCallId: "call-send",
        toolName: "message_send",
        input: { text: "hi" },
      },
      { type: "tool-result", toolCallId: "call-send", toolName: "message_send", output: "sent" },
      { type: "finish" },
    ],
    expectedCalls: [{ id: "call-send", tool: "message.send", input: { text: "hi" } }],
    expectedPart: {
      callID: "call-send",
      tool: "message.send",
      state: { status: "completed", title: "message.send" },
    },
  },
  {
    name: "synthesizes an error part for unmatched results",
    chunks: [
      {
        type: "tool-result",
        toolCallId: "forged-call",
        toolName: "weather",
        output: "forged",
      },
      { type: "finish" },
    ],
    expectedCalls: [],
    expectedResults: 0,
    expectedPart: {
      callID: "forged-call",
      state: { status: "error", error: "tool result for unknown call: forged" },
    },
  },
  {
    name: "projects tool-error parts as failed results",
    chunks: [
      {
        type: "tool-call",
        toolCallId: "call-weather",
        toolName: "weather",
        input: { city: "Seoul" },
      },
      { type: "tool-error", toolCallId: "call-weather", error: "network down" },
      { type: "finish" },
    ],
    expectedResults: 1,
    expectedResult: { toolCallId: "call-weather", content: "network down", isError: true },
    expectedPart: {
      callID: "call-weather",
      state: { status: "error", error: "network down" },
    },
  },
  {
    name: "keeps original call input when a result supplies different input",
    chunks: [
      {
        type: "tool-call",
        toolCallId: "call-weather",
        toolName: "weather",
        input: { city: "Seoul" },
      },
      {
        type: "tool-result",
        toolCallId: "call-weather",
        toolName: "weather",
        input: { city: "Tampered" },
        output: "sunny",
      },
      { type: "finish" },
    ],
    expectedPart: {
      callID: "call-weather",
      state: { status: "completed", input: { city: "Seoul" }, output: "sunny" },
    },
  },

  {
    name: "serializes structured output as JSON",
    chunks: [
      { type: "tool-call", toolCallId: "structured", toolName: "search", input: {} },
      {
        type: "tool-result",
        toolCallId: "structured",
        toolName: "search",
        output: { content: [{ type: "text", text: "hit" }] },
      },
    ],
    expectedResults: 1,
    expectedResult: {
      toolCallId: "structured",
      content: '{"content":[{"type":"text","text":"hit"}]}',
    },
    expectedPart: {
      callID: "structured",
      state: { status: "completed", output: '{"content":[{"type":"text","text":"hit"}]}' },
    },
  },
  {
    name: "preserves Error messages rather than serializing them to an empty object",
    chunks: [
      { type: "tool-call", toolCallId: "error-object", toolName: "search", input: {} },
      { type: "tool-error", toolCallId: "error-object", error: new Error("error fixture") },
    ],
    expectedResults: 1,
    expectedResult: { toolCallId: "error-object", content: "error fixture", isError: true },
    expectedPart: { callID: "error-object", state: { status: "error", error: "error fixture" } },
  },
];

describe("Processor tool result projection", () => {
  afterEach(() => {
    Bus.reset();
  });

  test("projects AI SDK tool-call and tool-result stream parts once", async () => {
    const toolCalls: Tool.Call[] = [];
    const toolResults: Tool.Result[] = [];
    const messages: Message.WithParts[] = [];
    const toolCallObserved = deferred();
    const toolResultReleased = deferred();
    const sink: Sink = {
      onMessage: (message) => messages.push(message),
      onToolCall: (call) => {
        toolCalls.push(call);
        toolCallObserved.resolve();
      },
      onToolResult: (result) => toolResults.push(result),
    };

    const processor = createProcessor({
      sink,
      createStream: async () => ({
        fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          yield {
            type: "tool-call",
            toolCallId: "call-weather",
            toolName: "weather",
            input: { city: "Seoul" },
          };
          await toolResultReleased.promise;
          yield {
            type: "tool-result",
            toolCallId: "call-weather",
            toolName: "weather",
            input: { city: "Seoul" },
            output: "sunny",
          };
          yield { type: "finish" };
        })(),
      }),
    });

    const processing = processor.process({ system: "", promptText: "" });
    await toolCallObserved.promise;
    const runningSnapshot = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.state.status === "running");
    expect(runningSnapshot).toBeDefined();
    toolResultReleased.resolve();
    await processing;

    expect(toolCalls).toEqual([{ id: "call-weather", tool: "weather", input: { city: "Seoul" } }]);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      toolCallId: "call-weather",
      content: "sunny",
    });
    const toolPart = messages.at(-1)?.parts.find((part) => part.type === "tool");
    expect(toolPart).toMatchObject({
      callID: "call-weather",
      tool: "weather",
      state: { status: "completed", output: "sunny" },
    });

    // The tool runs between tool-call and tool-result: start is recorded at
    // the call event, so the part reports a real duration.
    const state = toolPart?.type === "tool" ? toolPart.state : undefined;
    if (state?.status !== "completed") throw new Error("expected completed tool state");
    expect(state.time.end).toBeGreaterThanOrEqual(state.time.start);
  });

  test.each(toolProjectionCases)("$name", async ({
    chunks,
    toolNames,
    expectedCalls,
    expectedResults,
    expectedResult,
    expectedPart,
  }) => {
    const { toolCalls, toolResults, messages, sink } = capturingSink();

    const processor = createProcessor({
      sink,
      toolNames,
      createStream: async () => ({
        fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          yield* chunks;
        })(),
      }),
    });

    await processor.process({ system: "", promptText: "" });

    if (expectedCalls !== undefined) expect(toolCalls).toEqual(expectedCalls);
    if (expectedResults !== undefined) expect(toolResults).toHaveLength(expectedResults);
    if (expectedResult !== undefined) expect(toolResults[0]).toMatchObject(expectedResult);
    const toolPart = messages.at(-1)?.parts.find((part) => part.type === "tool");
    expect(toolPart).toMatchObject(expectedPart);
  });
});

describe("Processor abort settlement grace (#532 candidate 2)", () => {
  afterEach(() => {
    Bus.reset();
    mock.restore();
  });

  function captureSink(messages: Message.WithParts[]): Sink {
    return {
      onMessage: (message) => messages.push(message),
      onToolCall: () => undefined,
      onToolResult: () => undefined,
    };
  }

  function lastToolState(messages: Message.WithParts[]): Message.ToolPart["state"] | undefined {
    const parts = messages[messages.length - 1]?.parts ?? [];
    return parts.flatMap((part) => (part.type === "tool" ? [part.state] : []))[0];
  }

  const PENDING_CALL = { toolCallId: "call-grace", toolName: "write_file" } as const;

  /**
   * Streams one tool call, aborts, buffers an unrelated event, then streams
   * whatever `tail` produces — what the provider does while the grace drain
   * is pulling. Resolves with the final snapshots once the attempt has
   * rejected with the abort.
   */
  async function abortWithPendingTool(
    tail: () => Promise<StreamEvent[]>,
  ): Promise<Message.WithParts[]> {
    const messages: Message.WithParts[] = [];
    const abortController = new AbortController();
    const processor = createProcessor({
      abort: abortController.signal,
      sink: captureSink(messages),
      createStream: async () => ({
        fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          yield { type: "tool-call", ...PENDING_CALL, input: { path: "/tmp/x" } };
          abortController.abort();
          // The grace drain must skip unrelated buffered events and keep
          // pulling until the exact pending tool settles.
          yield { type: "text-delta", id: "buffered-text", text: "ignored during abort" };
          yield* await tail();
        })(),
      }),
    });
    await expect(processor.process({ system: "", promptText: "" })).rejects.toMatchObject({
      _tag: "TransportFailure", providerErrorName: "AbortError",
    });
    return messages;
  }

  test("tool result already in the stream at abort settles as completed", async () => {
    const messages = await abortWithPendingTool(async () => [
      { type: "tool-result", ...PENDING_CALL, output: { output: "written", isError: false } },
    ]);

    // The tool DID run (the SDK executes between tool-call and tool-result);
    // recording it as interrupted would misreport a real side effect.
    const state = lastToolState(messages);
    expect(state?.status).toBe("completed");
    if (state?.status === "completed") {
      expect(state.output).toBe("written");
      expect(state.time.end).toBeGreaterThanOrEqual(state.time.start);
    }
  });

  test("tool result that never arrives settles as interrupted when the grace timer fires", async () => {
    // This test measures the real bounded grace; no scheduler mocks can make it expire early.
    const messages = await abortWithPendingTool(() => new Promise(() => undefined));

    const state = lastToolState(messages);
    expect(state?.status).toBe("error");
    if (state?.status === "error") {
      // T1 vocabulary: abort-grace expiry advances the tool part with the
      // "interrupted" transition, which the fold projects as this error.
      expect(state.error).toBe("interrupted");
    }
  });

  test("a stream that fails inside the grace window settles the pending tool as interrupted", async () => {
    // The transport dies while the consumer is still draining for the result.
    const messages = await abortWithPendingTool(() =>
      Promise.reject(new Error("connection reset during drain")),
    );

    const state = lastToolState(messages);
    expect(state?.status).toBe("error");
    if (state?.status === "error") expect(state.error).toBe("interrupted");
  });
});
