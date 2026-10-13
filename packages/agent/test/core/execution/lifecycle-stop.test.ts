import { messageSource } from "../../helpers/message-source";
import { Effect } from "effect";
import { isolated } from "../../helpers/isolated";
import { failure } from "../../helpers/effect-g3";
import { describe, expect, it } from "bun:test";
import { createAssistantMessage } from "../../../src/core/journal/message-factory";
import { runTestAgent } from "../../helpers/effect-g3";
import { Bus } from "../../helpers/bus";
import { mockLlm, createStopOutcome } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

describe("run stop outcomes", () => {
  it("returns the current turn text and records one text step", async () => {
    const result = await isolated(runTestAgent(runInput([{ role: "user", content: "hello" }]), {
      events: Bus,
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: mockLlm(async (_input, sink) => {
        sink.onMessage(createAssistantMessage("original", "", "session", messageSource));
        return createStopOutcome();
      }),
    }));
    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("original");
    expect(result.steps).toEqual([{ type: "text", content: "original" }]);
  });

  it("does not resurrect prior text when a later continuation snapshot is empty", async () => {
    let calls = 0;
    const steps: string[] = [];
    const result = await isolated(failure(runTestAgent(runInput([{ role: "user", content: "hello" }]), {
      events: Bus,
      onStepFinish: (step) => Effect.sync(() => {
        steps.push(step.content);
      }),
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: mockLlm(async (_input, sink) => {
        calls += 1;
        if (calls === 1) {
          sink.onMessage(createAssistantMessage("first", "", "session", messageSource));
          return { type: "continue" };
        }
        sink.onMessage(createAssistantMessage("", "", "session", messageSource));
        return createStopOutcome();
      }),
    })));
    expect(result).toMatchObject({ code: "agent_stop", reason: "exact_repeat" });
    expect(steps).toEqual(["", "", ""]);
  });
});
