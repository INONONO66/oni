import { describe, expect, it } from "bun:test";
import { isolated } from "../../helpers/isolated";
import { failure, runTestAgent } from "../../helpers/effect-g3";
import { recoveryRecording } from "../../helpers/effect-g3r";
import { completeModel, providerFailure, windowedLlm } from "../../helpers/mock-llm";
import { collector } from "../../helpers/observation-collector";
import { runInput } from "../../helpers/run-input";

describe("compaction composed off", () => {
  it("settles two turns including a real overflow with zero compaction rows", async () => {
    const events = collector();
    const recording = recoveryRecording();
    let calls = 0;
    const llm = windowedLlm(async (input, sink) => {
      calls += 1;
      if (calls === 1) return completeModel(input, sink);
      return { type: "error", error: overflow };
    }, 1000);
    const overflow = providerFailure("prompt is too long", {
      failureClass: { kind: "overflow" },
      contextOverflow: true,
      retryable: false,
    });
    const config = {
      events,
      executor: recording.executor,
      model: { provider: "provider" as const, id: "model" },
      llm,
      compactionPort: undefined,
      compaction: undefined,
    };
    const history = [
      { role: "user" as const, content: "the goal" },
      { role: "assistant" as const, content: `old work ${"filler ".repeat(120)}` },
      { role: "user" as const, content: "first question" },
    ];

    const first = await isolated(runTestAgent(runInput(history), config));
    const secondFailure = await isolated(failure(runTestAgent(
      runInput([
        ...history,
        { role: "assistant", content: first.text },
        { role: "user", content: "overflowing question" },
      ]),
      config,
    )));

    expect(first.finishReason).toBe("stop");
    expect(secondFailure).toBe(overflow);
    expect(calls).toBe(2);
    expect(recording.committed.filter((action) => action.kind === "compaction")).toHaveLength(0);
  });
});
