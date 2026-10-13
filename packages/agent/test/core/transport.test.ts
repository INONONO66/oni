import { Effect } from "effect";
import { isolated } from "../helpers/isolated";
import { createTestAgent } from "../helpers/effect-g2";
import { describe, expect, it } from "bun:test";
import type { RunInput } from "../../src/core/llm";
import { collector } from "../helpers/observation-collector";
import { completeModel, mockProviderModel } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";

function transportHarness(transport?: RunInput["transport"]) {
  const seen: Array<RunInput["transport"]> = [];
  const agent = createTestAgent({
    events: collector(),
    model: { provider: "anthropic", id: mockProviderModel.id },
    ...(transport === undefined ? {} : { transport }),
    llm: {
      resolveModel: () => Effect.promise(async () => mockProviderModel),
      run: (input: import("../../src/core/llm").RunInput, sink: import("../../src/core/llm").LlmSink) =>
        Effect.promise(async () => {
          seen.push(input.transport);
          return completeModel(input, sink);
        }),
    },
  });
  return { agent, seen };
}

describe("operator transport config threading", () => {
  it("hands the configured baseUrl and headers to the llm call", async () => {
    const transport = {
      baseUrl: "https://gateway.internal/v1",
      headers: { "x-tenant": "acme" },
    };
    const { agent, seen } = transportHarness(transport);
    await isolated(agent.run(runInput([{ role: "user", content: "hi" }])));
    expect(seen).toEqual([transport]);
  });

  it("leaves transport absent when the host configured none", async () => {
    const { agent, seen } = transportHarness();
    await isolated(agent.run(runInput([{ role: "user", content: "hi" }])));
    expect(seen).toEqual([undefined]);
  });
});
