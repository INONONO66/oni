import { Effect } from "effect";
import { isolated } from "../../helpers/isolated";
import { failure } from "../../helpers/effect-g3";
import { describe, expect, it } from "bun:test";
import type { RunInput, RunResult, LlmSink as Sink } from "../../../src/core/ports/llm";
import type { Message } from "@oni/protocol";
import { runTestAgent } from "../../helpers/effect-g3";
import { collector } from "../../helpers/observation-collector";
import { runInput } from "../../helpers/run-input";
import { completeModel, windowedLlm } from "../../helpers/mock-llm";
import { assistantWithParts } from "../../helpers/messages";
import { toolBudgetConfig } from "../../helpers/run-config";

function assistant(reason: string, inputTokens = 900): Message.WithParts {
  return assistantWithReasons([reason], inputTokens);
}

function assistantWithReasons(reasons: readonly string[], inputTokens = 900): Message.WithParts {
  return assistantWithParts(
    "yield-assistant",
    "yield-session",
    [
      {
        id: "yield-text",
        sessionID: "yield-session",
        messageID: "yield-assistant",
        type: "text",
        text: "completed",
      },
      ...reasons.map((reason, index) => ({
        id: `yield-step-${index}`,
        sessionID: "yield-session",
        messageID: "yield-assistant",
        type: "step-finish" as const,
        reason,
        tokens: { input: inputTokens, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      })),
    ],
    inputTokens,
    1,
  );
}

function steeringLlm(run: (input: RunInput, sink: Sink) => Effect.Effect<RunResult>) {
  return {
    resolveModel: () => Effect.promise(async () => ({ id: "model", name: "model", providerID: "provider" })),
    run,
  };
}

describe("window and steering yield", () => {
  it("arms the provider call from the resolved model window", async () => {
    const arms: Array<number | undefined> = [];
    await isolated(runTestAgent(runInput([{ role: "user", content: "go" }]), {
      events: collector(),
      model: { provider: "provider", id: "model" },
      llm: windowedLlm(async (input, sink) => {
        arms.push(input.yieldAtInputTokens);
        return completeModel(input, sink);
      }),
    }));
    expect(arms).toEqual([450]);
  });

  it("continues on a window yield and disarms the next turn after no rewrite", async () => {
    const arms: Array<number | undefined> = [];
    let calls = 0;
    await isolated(runTestAgent(runInput([{ role: "user", content: "go" }]), {
      events: collector(),
      model: { provider: "provider", id: "model" },
      llm: windowedLlm(async (input, sink: Sink) => {
        calls += 1;
        arms.push(input.yieldAtInputTokens);
        if (calls !== 1) return completeModel(input, sink);
        sink.onMessage(assistant("tool-calls"));
        return { type: "stop" };
      }),
    }));
    expect(arms).toEqual([450, undefined]);
  });

  it("applies compaction before continuing a window yield", async () => {
    const seen: number[] = [];
    let calls = 0;
    const bulky = "filler ".repeat(120);
    const result = await isolated(runTestAgent(
      runInput([
        { role: "user", content: "goal" },
        { role: "assistant", content: `old one ${bulky}` },
        { role: "assistant", content: `old two ${bulky}` },
        { role: "user", content: "recent" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "continue" },
      ]),
      {
        events: collector(),
        model: { provider: "provider", id: "model" },
        compaction: {
          contextWindowTokens: 1000,
          protectRecentMessages: 2,
          speculate: false,
          onSummarize: () => Effect.promise(async () => "window checkpoint"),
        },
        llm: windowedLlm(async (input, sink: Sink) => {
          calls += 1;
          seen.push(input.messages.length);
          if (calls !== 1) return completeModel(input, sink);
          sink.onMessage(assistant("tool-calls"));
          return { type: "stop" };
        }),
      },
    ));
    expect(seen[1]).toBeLessThan(seen[0] ?? 0);
    expect(result.compactionCount).toBe(1);
  });

  it("aborts active speculative preparation when the run settles", async () => {
    let aborted = false;
    let calls = 0;
    await isolated(runTestAgent(
      runInput([
        { role: "user", content: "goal" },
        { role: "assistant", content: "old answer one" },
        { role: "assistant", content: "old answer two" },
        { role: "user", content: "follow-up" },
        { role: "assistant", content: "recent answer" },
        { role: "user", content: "continue" },
      ]),
      {
        events: collector(),
        model: { provider: "provider", id: "model" },
        compaction: {
          contextWindowTokens: 100_000,
          protectRecentMessages: 2,
          onSummarize: () => Effect.sync(() => { calls += 1; }).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => { aborted = true; })),
          ),
        },
        llm: windowedLlm(async (_input, sink: Sink) => {
          sink.onMessage(assistant("stop", 55_000));
          return { type: "stop" };
        }, 100_000),
      },
    ));
    expect(calls).toBe(1);
    expect(aborted).toBe(true);
  });

  it("treats unlimited tool calls as a window yield, never a step-cap terminal", async () => {
    let calls = 0;
    const result = await isolated(runTestAgent(runInput([{ role: "user", content: "go" }]), {
      ...toolBudgetConfig(-1),
      llm: windowedLlm(async (input, sink: Sink) => {
        calls += 1;
        if (calls !== 1) return completeModel(input, sink);
        sink.onMessage(assistantWithReasons(Array.from({ length: 30 }, () => "tool-calls")));
        return { type: "stop" };
      }),
    }));
    expect(calls).toBe(2);
    expect(result.finishReason).toBe("stop");
  });

  it("continues a steering yield instead of reporting max-steps", async () => {
    let pending = true;
    let calls = 0;
    const result = await isolated(runTestAgent(runInput([{ role: "user", content: "go" }]), {
      events: collector(),
      model: { provider: "provider", id: "model" },
      steeringPending: () => pending,
      llm: steeringLlm((input, sink) => Effect.promise(async () => {
          calls += 1;
          if (calls !== 1) return completeModel(input, sink);
          input.shouldYield?.();
          pending = false;
          sink.onMessage(assistant("tool-calls"));
          return { type: "stop" };
        })),
    }));
    expect(calls).toBe(2);
    expect(result.finishReason).toBe("stop");
  });

  it("keeps the step cap terminal when steering also fired", async () => {
    let calls = 0;
    const result = await isolated(failure(runTestAgent(runInput([{ role: "user", content: "go" }]), {
      ...toolBudgetConfig(1),
      steeringPending: () => true,
      llm: steeringLlm((input, sink) => Effect.promise(async () => {
          calls += 1;
          input.shouldYield?.();
          sink.onMessage(assistant("tool-calls"));
          return { type: "stop" };
        })),
    })));
    expect(calls).toBe(1);
    expect(result).toMatchObject({ code: "agent_stop", reason: "budget" });
  });

  it("compacts at the ordered boundary even when steering requests continuation", async () => {
    let pending = true;
    let calls = 0;
    const result = await isolated(runTestAgent(
      runInput([
        { role: "user", content: "goal" },
        { role: "assistant", content: `old ${"filler ".repeat(120)}` },
        { role: "assistant", content: `work ${"filler ".repeat(120)}` },
        { role: "user", content: "tail" },
      ]),
      {
        events: collector(),
        model: { provider: "provider", id: "model" },
        steeringPending: () => pending,
        compaction: {
          contextWindowTokens: 1000,
          protectRecentMessages: 2,
          speculate: false,
          onSummarize: () => Effect.promise(async () => "must not run"),
        },
        llm: windowedLlm(async (input, sink: Sink) => {
          calls += 1;
          if (calls === 1) {
            input.shouldYield?.();
            pending = false;
            sink.onMessage(assistant("tool-calls"));
          } else {
            sink.onMessage(assistant("stop", 100));
          }
          return { type: "stop" };
        }),
      },
    ));
    expect(calls).toBe(2);
    expect(result.compactionCount).toBe(1);
  });

  it("reports the step cap honestly", async () => {
    const result = await isolated(failure(runTestAgent(runInput([{ role: "user", content: "go" }]), {
      events: collector(),
      model: { provider: "provider", id: "model" },
      budget: { maxToolCalls: 1 },
      llm: steeringLlm((_input, sink) => Effect.promise(async () => {
          sink.onMessage(assistant("tool-calls"));
          return { type: "stop" };
        })),
    })));
    expect(result).toMatchObject({ code: "agent_stop", reason: "budget" });
  });
});
