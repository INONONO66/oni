import { describe, expect, test } from "bun:test";
import { toolResultText, type Message } from "@oni/protocol";
import { stringifyToolOutput, toModelMessages } from "../../src/message";
import type { Provider } from "../../src/provider";

const anthropicModel: Provider.Model = {
  id: "claude-3-5-sonnet",
  providerID: "anthropic",
  name: "Claude 3.5 Sonnet",
  api: { npm: "@ai-sdk/anthropic" },
};

function textPart(messageID: string, text: string, id = `part-${messageID}`): Message.TextPart {
  return { id, sessionID: "session-1", messageID, type: "text", text };
}

function userMessage(text = "Hello"): Message.WithParts {
  return {
    info: {
      id: "msg-1",
      sessionID: "session-1",
      role: "user",
      time: { created: 1000 },
      agent: "default",
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
    },
    parts: [textPart("msg-1", text, "part-1")],
  };
}

function assistantMessage(
  parts: Message.Part[] = [textPart("msg-2", "Response", "part-1")],
): Message.WithParts {
  return {
    info: {
      id: "msg-2",
      sessionID: "session-1",
      role: "assistant",
      time: { created: 1100 },
      parentID: "msg-1",
      modelID: "claude-3-5-sonnet",
      providerID: "anthropic",
      agent: "default",
      path: { cwd: "/home/user", root: "/home/user/project" },
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  };
}

describe("stringifyToolOutput", () => {
  test("falls back to String for circular values", () => {
    type Loop = { [key: string]: Loop };
    const circular: Loop = {};
    circular.self = circular;

    expect(stringifyToolOutput(circular)).toBe("[object Object]");
  });
});

describe("toModelMessages", () => {
  test("converts empty array", () => {
    expect(toModelMessages([], anthropicModel)).toEqual([]);
  });

  test("joins multiple text parts with a real LF", () => {
    const result = toModelMessages(
      [
        {
          ...userMessage(),
          parts: [textPart("msg-1", "first", "part-1"), textPart("msg-1", "second", "part-2")],
        },
      ],
      anthropicModel,
    );
    expect(result[0]?.content).toBe("first\nsecond");
  });

  test("converts UserMessage to model message", () => {
    const result = toModelMessages([userMessage()], anthropicModel);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.content).toBe("Hello");
  });

  test("converts AssistantMessage to model message", () => {
    const result = toModelMessages([assistantMessage()], anthropicModel);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
    expect(result[0]?.content).toBe("Response");
  });

  test("preserves assistant reasoning parts during conversion", () => {
    const reasoning: Message.ReasoningPart = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-2",
      type: "reasoning",
      text: "I should preserve this.",
      time: { start: 1100, end: 1101 },
    };
    const result = toModelMessages(
      [assistantMessage([reasoning, textPart("msg-2", "Final answer", "part-2")])],
      anthropicModel,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
    expect(result[0]?.content).toEqual([
      { type: "reasoning", text: "I should preserve this." },
      { type: "text", text: "Final answer" },
    ]);
  });

  test("converts mixed messages", () => {
    const result = toModelMessages([userMessage(), assistantMessage()], anthropicModel);
    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.content).toBe("Hello");
    expect(result[1]?.role).toBe("assistant");
    expect(result[1]?.content).toBe("Response");
  });

  test("normalizes empty content at the provider boundary", () => {
    const empty = assistantMessage([textPart("msg-2", "")]);
    expect(toModelMessages([empty], anthropicModel)).toEqual([]);
    const openai = {
      ...anthropicModel,
      id: "gpt-4o",
      providerID: "openai",
      api: { npm: "@ai-sdk/openai" },
    };
    expect(toModelMessages([empty], openai)).toMatchObject([{ role: "assistant", content: "" }]);
  });
});

/** The finished `msg-a` assistant carrying one completed `call-1` tool part for `tool` with `input` and `output`. */
function assistantWithCompletedCall(
  info: Partial<Message.AssistantMessage>,
  tool: string,
  input: Record<string, string>,
  output: string,
): Message.WithParts {
  return {
    info: assistantInfo({ ...info, finish: "stop" }),
    parts: [
      {
        id: "part-tool",
        sessionID: "session-1",
        messageID: "msg-a",
        type: "tool",
        callID: "call-1",
        tool,
        state: {
          status: "completed",
          input,
          output,
          time: { start: 1100, end: 1150 },
          title: tool,
          metadata: {},
        },
      } as Message.ToolPart,
    ],
  };
}

function assistantInfo(
  overrides: Partial<Message.AssistantMessage> = {},
): Message.AssistantMessage {
  return {
    id: "msg-a",
    sessionID: "session-1",
    role: "assistant",
    time: { created: 1100, completed: 1200 },
    parentID: "msg-u",
    modelID: "claude-3-5-sonnet",
    providerID: "anthropic",
    agent: "default",
    path: { cwd: "/", root: "/" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

describe("toModelMessages error-turn exclusion", () => {
  const model = anthropicModel;

  test("excludes error-finished assistant turns from replay", () => {
    const userMsg: Message.WithParts = {
      info: {
        id: "msg-u",
        sessionID: "session-1",
        role: "user",
        time: { created: 1000 },
        agent: "default",
        model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
      },
      parts: [textPart("msg-u", "Hello")],
    };
    const errored: Message.WithParts = {
      info: assistantInfo({ finish: "error" }),
      parts: [textPart("msg-a", "half-written failure output")],
    };

    const result = toModelMessages([userMsg, errored], model);

    // The error turn never reaches the provider; only the user turn replays.
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
  });

  test("keeps stop-finished assistant turns in replay", () => {
    const stopped: Message.WithParts = {
      info: assistantInfo({ finish: "stop" }),
      parts: [textPart("msg-a", "Answer")],
    };

    const result = toModelMessages([stopped], model);

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
  });
});

describe("toModelMessages tool-name wire sanitization (all providers)", () => {
  // A non-claude provider: the sanitize must run here too — the live-LLM
  // failure was an OpenAI-pattern proxy, and the claude-only normalize branch
  // never touches this model.
  const openaiModel: Provider.Model = {
    id: "gpt-4o",
    providerID: "openai-proxy",
    name: "Proxied",
    api: { npm: "@ai-sdk/openai" },
  };

  const assistantWithDottedToolCall = () =>
    assistantWithCompletedCall({ modelID: "gpt-4o", providerID: "openai-proxy" }, "message.send", { text: "hi" }, "sent");

  test("sanitizes tool-call and tool-result block names for a non-claude provider", () => {
    const result = toModelMessages([assistantWithDottedToolCall()], openaiModel);

    const assistant = result.find((m) => m.role === "assistant");
    const toolMsg = result.find((m) => m.role === "tool");
    if (!assistant || !Array.isArray(assistant.content))
      throw new Error("expected tool-call block");
    if (!toolMsg || !Array.isArray(toolMsg.content)) throw new Error("expected tool-result block");

    const toolCall = assistant.content.find((b) => b.type === "tool-call");
    const toolResult = toolMsg.content.find((b) => b.type === "tool-result");
    // The dotted internal name must not leak into the re-serialized history.
    expect((toolCall as { toolName?: string }).toolName).toBe("message_send");
    expect((toolResult as { toolName?: string }).toolName).toBe("message_send");
  });

  test("serializes failed tool history as an error result", () => {
    const message = assistantWithDottedToolCall();
    const tool = message.parts.find((part) => part.type === "tool");
    if (tool?.type !== "tool") throw new Error("expected tool part");
    tool.state = {
      status: "error",
      input: tool.state.input,
      error: "permission denied",
      time: { start: 1100, end: 1150 },
    };

    const result = toModelMessages([message], openaiModel);
    const toolMessage = result.find((item) => item.role === "tool");
    if (!toolMessage || !Array.isArray(toolMessage.content))
      throw new Error("expected tool result");
    expect(toolMessage.content[0]).toMatchObject({
      type: "tool-result",
      output: { type: "text", value: "Error: permission denied" },
    });
  });
});

describe("toModelMessages reasoning signature resend gate (#532 candidate 10)", () => {
  const outgoing: Provider.Model = {
    id: "claude-3-5-sonnet",
    providerID: "anthropic",
    name: "Claude 3.5 Sonnet",
    api: { npm: "@ai-sdk/anthropic" },
  };

  function reasoningMessage(overrides: Partial<Message.AssistantMessage> = {}): Message.WithParts {
    return {
      info: assistantInfo({
        id: "msg-r",
        tokens: { input: 0, output: 0, reasoning: 4, cache: { read: 0, write: 0 } },
        ...overrides,
      }),
      parts: [
        {
          id: "part-r",
          sessionID: "session-1",
          messageID: "msg-r",
          type: "reasoning",
          text: "step by step",
          signature: "sig-123",
          time: { start: 1100, end: 1150 },
        },
        {
          id: "part-t",
          sessionID: "session-1",
          messageID: "msg-r",
          type: "text",
          text: "Answer",
        },
      ],
    };
  }

  function reasoningBlockOf(result: ReturnType<typeof toModelMessages>) {
    const content = result[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected block content");
    return content.find((block) => block.type === "reasoning");
  }

  test("resends the signature when provider and model match the stored pair", () => {
    const result = toModelMessages([reasoningMessage()], outgoing);

    const block = reasoningBlockOf(result);
    expect(block).toMatchObject({
      type: "reasoning",
      text: "step by step",
      providerOptions: { anthropic: { signature: "sig-123" } },
    });
  });

  test("withholds the signature when the outgoing model differs", () => {
    const result = toModelMessages([reasoningMessage({ modelID: "claude-3-opus" })], outgoing);

    const block = reasoningBlockOf(result);
    expect(block).toMatchObject({ type: "reasoning", text: "step by step" });
    expect(block?.providerOptions).toBeUndefined();
  });

  test("withholds the signature when the outgoing provider differs", () => {
    const openaiModel: Provider.Model = {
      id: "claude-3-5-sonnet",
      providerID: "openai-proxy",
      name: "Proxied",
      api: { npm: "@ai-sdk/openai" },
    };

    const result = toModelMessages([reasoningMessage()], openaiModel);

    const block = reasoningBlockOf(result);
    expect(block?.providerOptions).toBeUndefined();
  });
});

describe("D5 tool result split at the model boundary", () => {
  const assistantWithToolText = (output: string) => assistantWithCompletedCall({}, "echo", { value: "x" }, output);

  function toolResultValue(
    messages: ReturnType<typeof toModelMessages>,
  ): { type: string; value: string } | undefined {
    const toolMsg = messages.find((m) => m.role === "tool");
    if (!toolMsg || !Array.isArray(toolMsg.content)) throw new Error("expected tool-result block");
    const block = toolMsg.content.find((b) => b.type === "tool-result");
    if (!block) throw new Error("expected tool-result block");
    return (block as { output?: { type: string; value: string } }).output;
  }

  test("the model message carries the result's content text and never details/structuredContent", () => {
    const result = {
      id: "call-1",
      toolCallId: "call-1",
      toolName: "echo",
      content: "answer=42",
      details: { errorKind: "none" },
      structuredContent: { answer: 42 },
    };
    const messages = toModelMessages([assistantWithToolText(toolResultText(result))], anthropicModel);
    expect(toolResultValue(messages)).toEqual({ type: "text", value: "answer=42" });
    const wire = JSON.stringify(messages);
    expect(wire).not.toContain("structuredContent");
    expect(wire).not.toContain("details");
  });

  test("a historical output-only result still renders its text to the model", () => {
    const historical = { id: "call-1", toolCallId: "call-1", output: "legacy text" };
    expect(toolResultText(historical)).toBe("legacy text");
    const messages = toModelMessages([assistantWithToolText(toolResultText(historical))], anthropicModel);
    expect(toolResultValue(messages)).toEqual({ type: "text", value: "legacy text" });
  });
});
