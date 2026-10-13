import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { RunEvents } from "../../../src/core/turn";
import { isolated } from "../../helpers/isolated";
import { runTestAgent } from "../../helpers/effect-g3";
import { assistantWithParts } from "../../helpers/messages";
import { completeModel, windowedLlm } from "../../helpers/mock-llm";
import { collector } from "../../helpers/observation-collector";
import { runInput } from "../../helpers/run-input";

const WINDOW = 1000;

/** A stop whose usage sits at the window's threshold: composed, this pressure compacts. */
function pressuredStop(id: string, inputTokens: number): Message.WithParts {
  return assistantWithParts(
    id,
    "off-session",
    [
      { id: `${id}-text`, sessionID: "off-session", messageID: id, type: "text", text: `answer ${id}` },
      {
        id: `${id}-step`,
        sessionID: "off-session",
        messageID: id,
        type: "step-finish",
        reason: "stop",
        tokens: { input: inputTokens, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
    inputTokens,
    1,
  );
}

describe("compaction composed off", () => {
  it("runs two turns, one under window pressure, terminal with zero compaction facts", async () => {
    const events = collector();
    const arms: Array<number | undefined> = [];
    const seen: number[] = [];
    let calls = 0;
    const llm = windowedLlm(async (input, sink) => {
      calls += 1;
      arms.push(input.yieldAtInputTokens);
      seen.push(input.messages.length);
      if (calls === 1) return completeModel(input, sink);
      sink.onMessage(pressuredStop(`pressured-${calls}`, WINDOW - 50));
      return { type: "stop" };
    }, WINDOW);
    const config = {
      events,
      model: { provider: "provider" as const, id: "model" },
      llm,
      compactionSeam: undefined,
      compaction: undefined,
    };
    const history = [
      { role: "user" as const, content: "the goal" },
      { role: "assistant" as const, content: `old work ${"filler ".repeat(120)}` },
      { role: "user" as const, content: "first question" },
    ];

    const first = await isolated(runTestAgent(runInput(history), config));
    const second = await isolated(runTestAgent(
      runInput([
        ...history,
        { role: "assistant", content: first.text },
        { role: "user", content: "overflowing question" },
      ]),
      config,
    ));

    expect([first.finishReason, second.finishReason]).toEqual(["stop", "stop"]);
    expect([first.compactionCount ?? 0, second.compactionCount ?? 0]).toEqual([0, 0]);
    expect(calls).toBe(2);
    // No port bound: nothing arms a window yield and the full history reaches the model.
    expect(arms).toEqual([undefined, undefined]);
    expect(seen[1]).toBeGreaterThan(seen[0] ?? 0);
    expect(events.named(RunEvents.CompactionStarted.name)).toHaveLength(0);
    expect(events.named(RunEvents.CompactionCompleted.name)).toHaveLength(0);
  });
});
