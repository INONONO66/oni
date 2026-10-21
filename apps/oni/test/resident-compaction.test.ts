import { testToolPorts } from "./helpers/tool-ports";
import { Effect } from "effect";
import { describe, expect, it } from "bun:test";
import type { Core } from "@oni/agent";
type Sink = Core.LlmSink;
import { residentRunner as createResident } from "./helpers/resident-runner";
import { assistantMessage } from "./helpers/assistant-message";
import { testPlane } from "./helpers/ledger";

describe("Resident compaction", () => {
  it("replaces oversized hydrated history before continuing the Resident run", async () => {
    const sessionId = "resident-compaction";
    // One shared plane: the second resident must hydrate the seeded history.
    const plane = testPlane();

    const seed = createResident({
      plane,
      model: { provider: "fake", id: "resident-test" },
      apiKey: "test-key",
      tools: { ...testToolPorts,},
      llm: {
        resolveModel: (model) => Effect.succeed(({
          id: model.id,
          name: model.id,
          providerID: model.provider,
          limit: { context: 100_000 },
        })),
        run: (input, sink: Sink) => Effect.sync(() => {
          sink.onMessage(assistantMessage(input, { text: `seed answer ${"filler ".repeat(30)}` }));
          return { type: "stop" };
        }),
      },
    });
    for (let index = 0; index < 6; index += 1) {
      await seed.prompt(sessionId, `seed question ${index} ${"filler ".repeat(30)}`);
    }

    const messageCounts: number[] = [];
    let calls = 0;
    const resident = createResident({
      plane,
      model: { provider: "fake", id: "resident-test" },
      apiKey: "test-key",
      compaction: () => Effect.succeed({
        contextWindowTokens: 700,
        elideToolOutputs: { minOutputChars: 4000, keepHeadChars: 500 },
      }),
      tools: { ...testToolPorts,},
      llm: {
        resolveModel: (model) => Effect.succeed(({
          id: model.id,
          name: model.id,
          providerID: model.provider,
          limit: { context: 700 },
        })),
        run: (input, sink: Sink) => Effect.sync(() => {
          calls += 1;
          messageCounts.push(input.messages?.length ?? 0);
          sink.onMessage(
            assistantMessage(input, {
              call: calls,
              reason: calls === 1 ? "tool-calls" : "stop",
              tokens: { input: 650, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            }),
          );
          return { type: "stop" };
        }),
      },
    });

    await resident.prompt(sessionId, "new resident question");

    expect(calls).toBe(2);
    expect(messageCounts[1]).toBeLessThan(messageCounts[0] ?? 0);
  });
});
