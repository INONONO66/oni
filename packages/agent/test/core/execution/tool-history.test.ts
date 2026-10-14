import { messageSource } from "../../helpers/message-source";
import { bounded } from "../../helpers/bounded";
import { Effect } from "effect";
import { isolated } from "../../helpers/isolated";
import { failure } from "../../helpers/effect-g1";
import { providerFailure } from "../../helpers/mock-llm";
import { createTestAgent } from "../../helpers/effect-g1";
import { describe, expect, it } from "bun:test";
import type { LlmSink as Sink, ResolvedModel } from "../../../src/core/ports/llm";
import type { Message } from "@openomni/protocol";
import { RunEvents } from "../../../src/core/loop/turn";
import { createAssistantMessage } from "../../../src/core/journal/message-factory";
import { Bus } from "../../helpers/bus";
import { createStopOutcome, type MockLlmFn } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";
import { stepFinish } from "../../helpers/messages";

const providerModel: ResolvedModel = {
  id: "claude-3-haiku-20240307",
  name: "Claude 3 Haiku",
  providerID: "anthropic",
};

function toolSnapshot(id: string, text: string, reason: "tool-calls" | "stop"): Message.WithParts {
  const base = createAssistantMessage(text, "", "session", messageSource);
  if (base.info.role !== "assistant") throw new Error("expected assistant message");
  const tool: Message.ToolPart = {
    id: `${id}-tool`,
    sessionID: "session",
    messageID: id,
    type: "tool",
    callID: "call-1",
    tool: "lookup",
    state: {
      status: "completed",
      input: { q: "answer" },
      output: "42",
      title: "lookup",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
  return {
    ...base,
    info: {
      ...base.info,
      id,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      tool,
      ...base.parts.map((part) => ({ ...part, messageID: id })),
      stepFinish(id, reason, 100, 50),
    ],
  };
}

function agent(run: MockLlmFn, steeringPending?: () => boolean) {
  return createTestAgent({
    events: Bus,
    model: { provider: "anthropic", id: providerModel.id },
    llm: { run: (input, sink) => Effect.promise(() => run(input, sink)), resolveModel: () => Effect.succeed(providerModel) },
    ...(steeringPending === undefined ? {} : { steeringPending }),
  });
}

describe("tool-bearing history", () => {
  it("feeds a completed tool call and result into the next model turn", async () => {
    const inputs: Message.WithParts[][] = [];
    let pending = true;
    let calls = 0;
    const result = await isolated(agent(
      async (input, sink: Sink) => {
        calls += 1;
        inputs.push([...(input.messages as Message.WithParts[])]);
        input.shouldYield?.();
        if (calls === 1) {
          pending = false;
          sink.onMessage(toolSnapshot("first", "answer", "tool-calls"));
        } else sink.onMessage(createAssistantMessage("done", "", "session", messageSource));
        return createStopOutcome();
      },
      () => pending,
    ).run(runInput([{ role: "user", content: "question" }])));

    expect(result.finishReason).toBe("stop");
    const second = inputs[1] ?? [];
    const assistant = second.find((message) => message.info.id === "first");
    // The port receives the completed tool part with its call id and output
    // intact; rendering that part as provider tool-call/tool-result blocks is
    // the call layer's and is tested beside it in packages/llm (#1352).
    const toolParts = (assistant?.parts ?? []).filter((part): part is Message.ToolPart => part.type === "tool");
    expect(toolParts).toHaveLength(1);
    expect(toolParts.map((part) => part.callID)).toEqual(["call-1"]);
    expect(toolParts[0]?.state).toMatchObject({ status: "completed", output: "42" });
  });

  it("preserves accumulated tool history and usage across an agent retry", async () => {
    const retry = Promise.withResolvers<void>();
    const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, () => retry.resolve());
    const inputs: Message.WithParts[][] = [];
    let pending = true;
    let calls = 0;
    try {
      const running = isolated(agent(
        async (input, sink) => {
          calls += 1;
          inputs.push([...(input.messages as Message.WithParts[])]);
          if (calls === 1) {
            input.shouldYield?.();
            pending = false;
            sink.onMessage(toolSnapshot("first", "answer", "tool-calls"));
            return createStopOutcome();
          }
          if (calls === 2) return { type: "error", error: providerFailure("transient failure", { failureClass: { kind: "retryable", reason: "transient_error", providerReason: "server_error", afterMs: 0, directed: true, instant: false } }) };
          sink.onMessage(createAssistantMessage("done", "", "session", messageSource));
          return createStopOutcome();
        },
        () => pending,
      ).run(runInput([{ role: "user", content: "question" }])));
      await bounded(retry.promise);
      const result = await running;
      expect(calls).toBe(3);
      expect(inputs).toHaveLength(3);
      expect(inputs[2]?.some((message) => message.info.id === "first")).toBe(true);
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    } finally {
      unsubscribe();
    }
  });

  it("does not resurrect prior text when the next turn emits an empty snapshot", async () => {
    let pending = true;
    let calls = 0;
    const result = await isolated(failure(agent(
      async (input, sink) => {
        calls += 1;
        if (calls === 1) {
          input.shouldYield?.();
          pending = false;
          sink.onMessage(toolSnapshot("first", "done", "tool-calls"));
        } else sink.onMessage(createAssistantMessage("", "", "session", messageSource));
        return createStopOutcome();
      },
      () => pending,
    )
      .run(runInput([{ role: "user", content: "question" }]))
      ));
    expect(result).toMatchObject({ code: "agent_stop", reason: "toolless_stall" });
    expect(calls).toBe(3);
  });
});
