import { describe, test, expect } from "bun:test";
import { ZodError } from "zod";
import { Gateway } from "../src/gateway/index.js";
import { Message } from "../src/message/index.js";

const base = { id: "p-1", sessionID: "ses-1", messageID: "msg-1" };

describe("Message.TextPart", () => {
  test("parses valid minimal text part", () => {
    const part = Message.TextPart.parse({
      ...base,
      type: "text",
      text: "hello",
    });

    expect(part.type).toBe("text");
    expect(part.text).toBe("hello");
    expect(part.time).toBeUndefined();
    expect(part.metadata).toBeUndefined();
  });

  test("parses valid full text part with time and metadata", () => {
    const part = Message.TextPart.parse({
      ...base,
      type: "text",
      text: "hello",
      time: { start: 100, end: 200 },
      metadata: { source: "user" },
    });

    expect(part.time?.start).toBe(100);
    expect(part.time?.end).toBe(200);
    expect(part.metadata).toEqual({ source: "user" });
  });

  test("parses the full persisted metadata value grammar with a typed result", () => {
    const part = Message.TextPart.parse({
      ...base,
      type: "text",
      text: "hello",
      metadata: { nullable: null, nested: [[], {}] },
    });
    expect(part.metadata).toEqual({ nullable: null, nested: [[], {}] });
  });

  test("rejects missing text", () => {
    expect(() => Message.TextPart.parse({ ...base, type: "text" })).toThrow(ZodError);
  });
});

describe("Message.ReasoningPart", () => {
  test("parses valid reasoning part with required time", () => {
    const part = Message.ReasoningPart.parse({
      ...base,
      type: "reasoning",
      text: "thinking...",
      time: { start: 10 },
    });

    expect(part.type).toBe("reasoning");
    expect(part.text).toBe("thinking...");
    expect(part.time.start).toBe(10);
    expect(part.time.end).toBeUndefined();
  });

  test("rejects missing time", () => {
    expect(() =>
      Message.ReasoningPart.parse({
        ...base,
        type: "reasoning",
        text: "thinking...",
      }),
    ).toThrow(ZodError);
  });

  test("rejects missing text", () => {
    expect(() =>
      Message.ReasoningPart.parse({
        ...base,
        type: "reasoning",
        time: { start: 10 },
      }),
    ).toThrow(ZodError);
  });
});

describe("Message.StepStartPart", () => {
  test("parses valid step-start part", () => {
    const part = Message.StepStartPart.parse({
      ...base,
      type: "step-start",
    });

    expect(part.type).toBe("step-start");
    expect(part.id).toBe("p-1");
  });
});

describe("Message.StepFinishPart", () => {
  test("step-finish lane defaults are read-side migration for pre-#61 parts", () => {
    const part = Message.StepFinishPart.parse({
      ...base,
      type: "step-finish",
      reason: "end_turn",
      tokens: { input: 100, output: 50, reasoning: 7, cache: { read: 90, write: 3 } },
    });
    expect(part.tokens).toEqual({
      input: 100,
      output: 50,
      reasoning: 7,
      cache: { read: 90, write: 3 },
    });

    // Pin (DEFAULT-LIVE): parts persisted before #61 lack the lanes and the
    // part adapter schema-parses EVERY read — dropping these defaults makes
    // old transcripts unreadable (#669 review B1).
    const legacy = Message.StepFinishPart.parse({
      ...base,
      type: "step-finish",
      reason: "end_turn",
      tokens: { input: 100, output: 50 },
    });
    expect(legacy.tokens).toEqual({
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
  });

  test("accepts step finish without cost, and a historical part with cost: 0 still reads", () => {
    const part = Message.StepFinishPart.parse({
      ...base,
      type: "step-finish",
      reason: "end_turn",
      tokens: { input: 100, output: 50 },
    });
    expect(part.reason).toBe("end_turn");
    expect("cost" in part).toBe(false);

    // DEFAULT-LIVE: parts persisted before #1344 carry cost: 0; the read-side
    // parse ignores the retired field instead of refusing the transcript.
    const historical = Message.StepFinishPart.parse({
      ...base,
      type: "step-finish",
      reason: "end_turn",
      cost: 0,
      tokens: { input: 100, output: 50 },
    });
    expect("cost" in historical).toBe(false);
  });

  test("rejects missing tokens", () => {
    expect(() =>
      Message.StepFinishPart.parse({
        ...base,
        type: "step-finish",
        reason: "end_turn",
      }),
    ).toThrow(ZodError);
  });

  test("rejects negative and fractional token counts", () => {
    expect(() =>
      Message.StepFinishPart.parse({
        ...base,
        type: "step-finish",
        reason: "end_turn",
        tokens: { input: -1, output: 50 },
      }),
    ).toThrow(ZodError);

    expect(() =>
      Message.StepFinishPart.parse({
        ...base,
        type: "step-finish",
        reason: "end_turn",
        tokens: { input: 100, output: 50, cache: { read: 1.5, write: 0 } },
      }),
    ).toThrow(ZodError);
  });
});

describe("Message.ToolPart", () => {
  const toolBase = {
    ...base,
    type: "tool" as const,
    callID: "c-1",
    tool: "search",
  };

  test("parses with pending state", () => {
    const part = Message.ToolPart.parse({
      ...toolBase,
      state: { status: "pending", input: {} },
    });

    expect(part.type).toBe("tool");
    expect(part.state.status).toBe("pending");
  });

  test("parses with running state", () => {
    const part = Message.ToolPart.parse({
      ...toolBase,
      state: { status: "running", input: {}, time: { start: 0 } },
    });

    expect(part.state.status).toBe("running");
  });

  test("parses with completed state", () => {
    const part = Message.ToolPart.parse({
      ...toolBase,
      state: {
        status: "completed",
        input: {},
        output: "ok",
        title: "t",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    });

    expect(part.state.status).toBe("completed");
  });

  test("parses with error state", () => {
    const part = Message.ToolPart.parse({
      ...toolBase,
      state: {
        status: "error",
        input: {},
        error: "fail",
        time: { start: 0, end: 1 },
      },
    });

    expect(part.state.status).toBe("error");
  });

  test("rejects missing callID", () => {
    expect(() =>
      Message.ToolPart.parse({
        ...base,
        type: "tool",
        tool: "search",
        state: { status: "pending", input: {} },
      }),
    ).toThrow(ZodError);
  });

  test("rejects wrong Tool.State status", () => {
    expect(() =>
      Message.ToolPart.parse({
        ...toolBase,
        state: { status: "done", input: {} },
      }),
    ).toThrow(ZodError);
  });
});

describe("Message.Part", () => {
  test("rejects unknown type literal", () => {
    expect(() => Message.Part.parse({ ...base, type: "unknown" })).toThrow(ZodError);
  });
});

const msgBase = { id: "msg-1", sessionID: "ses-1" };

describe("Message.UserMessage", () => {
  const validUser = {
    ...msgBase,
    role: "user" as const,
    time: { created: 1000 },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-opus-4-20250514" },
  };

  test("parses valid minimal user message", () => {
    const msg = Message.UserMessage.parse(validUser);

    expect(msg.role).toBe("user");
    expect(msg.agent).toBe("build");
    expect(msg.system).toBeUndefined();
    expect(msg.tools).toBeUndefined();
    expect(msg.variant).toBeUndefined();
  });

  test("parses valid full user message with system, tools, variant", () => {
    const msg = Message.UserMessage.parse({
      ...validUser,
      system: "You are helpful.",
      tools: { search: true, write: false },
      variant: "fast",
    });

    expect(msg.system).toBe("You are helpful.");
    expect(msg.tools).toEqual({ search: true, write: false });
    expect(msg.variant).toBe("fast");
  });

  test("rejects missing agent", () => {
    const { agent: _, ...noAgent } = validUser;
    expect(() => Message.UserMessage.parse(noAgent)).toThrow(ZodError);
  });

  test("rejects wrong role", () => {
    expect(() => Message.UserMessage.parse({ ...validUser, role: "assistant" })).toThrow(ZodError);
  });
});

describe("Message.AssistantMessage", () => {
  const validAssistant = {
    ...msgBase,
    role: "assistant" as const,
    time: { created: 1000 },
    parentID: "msg-0",
    modelID: "claude-opus-4-20250514",
    providerID: "anthropic",
    agent: "build",
    path: { cwd: "/home", root: "/" },
    tokens: {
      input: 500,
      output: 200,
      reasoning: 0,
      cache: { read: 100, write: 50 },
    },
  };

  test("parses valid minimal assistant message", () => {
    const msg = Message.AssistantMessage.parse(validAssistant);

    expect(msg.role).toBe("assistant");
    expect(msg.parentID).toBe("msg-0");
    expect(msg.tokens.cache.read).toBe(100);
    expect(msg.time.completed).toBeUndefined();
    expect(msg.finish).toBeUndefined();
  });

  test("rejects missing parentID", () => {
    const { parentID: _, ...noParent } = validAssistant;
    expect(() => Message.AssistantMessage.parse(noParent)).toThrow(ZodError);
  });

  test("rejects negative and fractional token counts", () => {
    expect(() =>
      Message.AssistantMessage.parse({
        ...validAssistant,
        tokens: { ...validAssistant.tokens, output: -1 },
      }),
    ).toThrow(ZodError);

    expect(() =>
      Message.AssistantMessage.parse({
        ...validAssistant,
        tokens: {
          ...validAssistant.tokens,
          cache: { read: 1.5, write: 50 },
        },
      }),
    ).toThrow(ZodError);
  });
});

describe("Message.Info", () => {
  test("rejects wrong role", () => {
    expect(() => Message.Info.parse({ ...msgBase, role: "system" })).toThrow(ZodError);
  });
});

describe("Message.WithParts", () => {
  const userInfo = {
    ...msgBase,
    role: "user" as const,
    time: { created: 1000 },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-opus-4-20250514" },
  };

  const textPart = {
    ...base,
    type: "text" as const,
    text: "hello",
  };

  test("parses valid WithParts", () => {
    const wp = Message.WithParts.parse({
      info: userInfo,
      parts: [textPart],
    });

    expect(wp.info.role).toBe("user");
    expect(wp.parts).toHaveLength(1);
    expect(wp.parts[0]?.type).toBe("text");
  });

  test("rejects missing info", () => {
    expect(() => Message.WithParts.parse({ parts: [textPart] })).toThrow(ZodError);
  });

  test("rejects missing parts", () => {
    expect(() => Message.WithParts.parse({ info: userInfo })).toThrow(ZodError);
  });
});

describe("Gateway.IngressFacts", () => {
  test("parses video and voice audio attachments", () => {
    const facts = Gateway.IngressFacts.parse({
      eventId: "in-1",
      surface: "telegram",
      channelId: "chat-1",
      addressees: [],
      dm: true,
      payload: {},
      render: "media",
      attachments: [
        { kind: "video", ref: "video-1", durationMs: 12_000 },
        { kind: "audio", ref: "audio-1", voice: true, durationMs: 4_200 },
      ],
    });
    expect(facts.attachments).toEqual([
      { kind: "video", ref: "video-1", durationMs: 12_000 },
      { kind: "audio", ref: "audio-1", voice: true, durationMs: 4_200 },
    ]);
  });
});
