import { isolated } from "../../helpers/isolated";
import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { runTestAgent } from "../../helpers/effect-g2";
import { Bus } from "../../helpers/bus";
import { mockLlm, completeModel } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

describe("turn provenance", () => {
  it("preserves hydrated assistant role and parent linkage in model history", async () => {
    let messages: readonly Message.WithParts[] = [];
    await isolated(
      runTestAgent(
        runInput([
          { role: "user", content: "parent request" },
          { role: "assistant", content: "child result" },
        ]),
        {
          events: Bus,
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
          llm: mockLlm(
            async (input: import("../../../src/core/llm").RunInput, sink: import("../../../src/core/llm").LlmSink) => {
              messages = [...input.messages];
              return completeModel(input, sink);
            },
          ),
        },
      ),
    );
    expect(messages.at(-1)?.info).toMatchObject({
      role: "assistant",
      parentID: messages.at(-2)?.info.id,
    });
    expect(messages.at(-1)?.parts[0]).toMatchObject({ type: "text", text: "child result" });
  });
});
