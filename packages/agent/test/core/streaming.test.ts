import type { RunInput } from "../../src/core/ports/llm";
import type { Message } from "@oni/protocol";
import { Effect } from "effect";
import { isolated } from "../helpers/isolated";
import { createTestAgent } from "../helpers/g0-effect";
import { describe, expect, it } from "bun:test";
import type { LlmSink as Sink } from "../../src/core/ports/llm";
import type { Tool } from "@oni/protocol";
import { createStopOutcome, type MockLlmFn, mockLlm as portFake } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";
import { Bus } from "../helpers/bus";
import { streamingAssistantInfo } from "../helpers/messages";

let mockRunFn: MockLlmFn = async () => createStopOutcome();

const mockLlm = portFake((input: RunInput, sink: Sink) => mockRunFn(input, sink));

const defaultConfig = {
  events: Bus,
  model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  llm: mockLlm,
};

const defaultInput = runInput([{ role: "user" as const, content: "hello" }]);

/**
 * The caller's view of a run in progress, and now the only one: the
 * `AgentEvent` generator that narrated the same facts had no consumer outside
 * these tests. What a caller can observe is exactly what reaches the sink it
 * passed, plus the result it is returned.
 */
function collectingSink(): Sink & {
  readonly texts: string[];
  readonly toolCalls: Tool.Call[];
  readonly toolResults: Tool.Result[];
} {
  const texts: string[] = [];
  const toolCalls: Tool.Call[] = [];
  const toolResults: Tool.Result[] = [];
  return {
    texts,
    toolCalls,
    toolResults,
    onMessage: (message: Message.WithParts) => {
      for (const part of message.parts) {
        if (part.type === "text") texts.push(part.text);
      }
    },
    onToolCall: (call: Tool.Call) => toolCalls.push(call),
    onToolResult: (result: Tool.Result) => toolResults.push(result),
  };
}

describe("ChatAgent.run() streaming", () => {
  it("streams assistant text to the sink and returns the result", async () => {
    mockRunFn = async (_input: RunInput, sink: Sink) => {
      sink.onMessage({
        info: streamingAssistantInfo("msg-1", 10, 5),
        parts: [
          {
            id: "p1",
            sessionID: "test",
            messageID: "msg-1",
            type: "text",
            text: "Hello world",
          },
        ],
      });
      return createStopOutcome();
    };

    const sink = collectingSink();
    const result = await isolated(createTestAgent(defaultConfig).run(defaultInput, sink));

    expect(sink.texts).toEqual(["Hello world"]);
    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("Hello world");
  });

  it("streams tool calls and their results to the sink", async () => {
    let step = 0;
    mockRunFn = async (_input: RunInput, sink: Sink) => {
      step += 1;
      const call = { id: "call-1", tool: "test_tool", input: { q: "test" } };
      if (step === 1) sink.onToolCall(call);
      sink.onMessage({
        info: streamingAssistantInfo("msg-2", 5, 3),
        parts: [
          ...(step === 1
            ? [
                {
                  id: "tool-part",
                  sessionID: "test",
                  messageID: "msg-2",
                  type: "tool" as const,
                  callID: call.id,
                  tool: call.tool,
                  state: { status: "pending" as const, input: call.input },
                },
              ]
            : []),
          {
            id: "p2",
            sessionID: "test",
            messageID: "msg-2",
            type: "text",
            text: "Done",
          },
        ],
      });
      return createStopOutcome();
    };

    const agent = createTestAgent({
      ...defaultConfig,
      toolExecutor: (call: Tool.Call) =>
        Effect.succeed({
          id: crypto.randomUUID(),
          toolCallId: call.id,
          content: "tool result",
          isError: false,
        }),
    });

    const sink = collectingSink();
    const result = await isolated(agent.run(defaultInput, sink));

    expect(sink.toolCalls.map((call: Tool.Call) => call.tool)).toEqual(["test_tool"]);
    expect(sink.toolResults.map((r: Tool.Result) => r.content)).toEqual(["tool result"]);
    expect(result.finishReason).toBe("stop");
  });
});
