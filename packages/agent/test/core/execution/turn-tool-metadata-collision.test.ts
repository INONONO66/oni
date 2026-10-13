import type { ChatFixture as ChatAgentConfig } from "../../helpers/chat-services";
import { Effect } from "effect";
import { isolated } from "../../helpers/isolated";
import { failure } from "../../helpers/effect-g3";
import { describe, expect, it } from "bun:test";
import { Bus } from "../../helpers/bus";
import { runTestAgent } from "../../helpers/effect-g3";
import type {} from "../../../src/core/types";
import { mockLlm, completeModel } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

/**
 * Tool metadata keys must be unambiguous: a tool named `a_b` also claims the
 * underscore-mangled alias `a.b`, so a second tool literally named `a.b` used to
 * silently hand its labels to the earlier tool's policy lookups (last-writer-wins
 * on a shared key). The collision now refuses the run before it opens, naming both.
 */
function config(tools: NonNullable<ChatAgentConfig["tools"]>): ChatAgentConfig {
  return {
    events: Bus,
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    tools,
    toolExecutor: (call) => Effect.promise(async () => ({
      id: "result-1",
      toolCallId: call.id,
      output: "ok",
      isError: false,
    })),
    llm: mockLlm(completeModel),
  };
}

function spec(name: string) {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object" as const, properties: {} },
    labels: [`origin:${name}`],
  };
}

describe("tool metadata key collisions", () => {
  it("refuses a catalog where a_b's alias collides with a tool named a.b", async () => {
    expect(await isolated(failure(runTestAgent(runInput([{ role: "user", content: "hi" }]), config([spec("a_b"), spec("a.b")]))))).toBeInstanceOf(Error);
  });

  it("refuses two distinct tools carrying the same name (identity, not name, owns a key)", async () => {
    // The mangling seam can manufacture this: name-keyed ownership would see
    // "same name, no conflict" and let the later tool answer the earlier
    // tool's policy lookups.
    expect(await isolated(failure(runTestAgent(runInput([{ role: "user", content: "hi" }]), config([spec("a.b"), spec("a.b")]))))).toBeInstanceOf(Error);
  });

  it("a single tool claiming its own alias keys stays legal", async () => {
    const result = await isolated(runTestAgent(
      runInput([{ role: "user", content: "hi" }]),
      config([spec("a_b")]),
    ));
    expect(result.finishReason).toBe("stop");
  });
});
