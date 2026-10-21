import { describe, expect, test } from "bun:test";
import type { Core } from "@oni/agent";
type RunInput = Core.RunInput;
import { assistantMessage } from "./assistant-message";
import { testIds } from "./test-entropy";

const input: RunInput = {
  messages: [],
  tools: [],
  model: { id: "model-id", providerID: "provider-id", name: "Test model" },
  trace: { traceId: "trace-id", sessionId: "session-id", runId: "run-id" },
  events: { publish: () => undefined },
  now: () => 0,
  id: testIds("run"),
};

describe("assistantMessage", () => {
  test("builds an assistant reply from a run input", () => {
    expect(assistantMessage(input, { id: "message-id", createdAt: 123, text: "reply" })).toEqual({
      info: {
        id: "message-id",
        sessionID: "session-id",
        role: "assistant",
        time: { created: 123 },
        parentID: "",
        modelID: "model-id",
        providerID: "provider-id",
        agent: "resident",
        path: { cwd: "", root: "" },
        tokens: { input: 4, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: "message-id-text",
          sessionID: "session-id",
          messageID: "message-id",
          type: "text",
          text: "reply",
        },
        {
          id: "message-id-finish",
          sessionID: "session-id",
          messageID: "message-id",
          type: "step-finish",
          reason: "stop",
          tokens: { input: 4, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
    });
  });

  test("derives call-count reply metadata", () => {
    const message = assistantMessage(input, {
      call: 1,
      reason: "tool-calls",
      tokens: { input: 90, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    expect(message.info.id).toBe("assistant-1");
    expect(message.parts).toEqual([
      {
        id: "assistant-1-text",
        sessionID: "session-id",
        messageID: "assistant-1",
        type: "text",
        text: "reply 1",
      },
      expect.objectContaining({ reason: "tool-calls" }),
    ]);
  });
});
