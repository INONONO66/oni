import { Cause, Effect, Exit } from "effect";
import { isolated } from "../../helpers/isolated";
import { completeModel, providerFailure } from "../../helpers/mock-llm";
import { describe, expect, it } from "bun:test";
import { runTestAgent } from "../../helpers/effect-g1";
import { collector } from "../../helpers/observation-collector";
import { runInput } from "../../helpers/run-input";
import { overflowCompactionConfig } from "../../helpers/run-config";
import { RunEvents } from "../../../src/core/loop/turn";

const model = {
  id: "model",
  name: "model",
  providerID: "provider",
  limit: { context: 10_000, output: 100 },
};

function effectOverflowCompactionConfig() {
  const config = overflowCompactionConfig();
  return {
    ...config,
    compaction: { ...config.compaction, onSummarize: () => Effect.succeed("overflow checkpoint") },
  };
}

const history = runInput([
  { role: "user", content: "the goal" },
  { role: "assistant", content: `old work one ${"filler ".repeat(120)}` },
  { role: "assistant", content: `old work two ${"filler ".repeat(120)}` },
  { role: "user", content: "recent question" },
  { role: "assistant", content: "recent answer" },
  { role: "user", content: "continue" },
]);

function overflowLlm(onRun: () => ReturnType<typeof providerFailure>) {
  return {
    resolveModel: () => Effect.succeed(model),
    run: () => Effect.sync(() => ({ type: "error" as const, error: onRun() })),
  };
}

/** The run must fail with exactly the given provider error as its squashed cause. */
async function expectSquashedCause<A, E>(
  running: Promise<Exit.Exit<A, E>>,
  expected: ReturnType<typeof providerFailure>,
): Promise<void> {
  const exit = await running;
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(expected);
}

describe("context overflow recovery", () => {
  it("does not blindly retry when compaction is unavailable and preserves the failure", async () => {
    const original = providerFailure("prompt is too long", {
      failureClass: { kind: "overflow" },
      contextOverflow: true,
      retryable: false,
    });
    let calls = 0;
    const running = isolated(
      Effect.exit(
        runTestAgent(history, {
          events: collector(),
          model: { provider: "provider", id: "model" },
          llm: overflowLlm(() => {
            calls += 1;
            return original;
          }),
        }),
      ),
    );

    await expectSquashedCause(running, original);
    expect(calls).toBe(1);
  });

  it("compacts once and the same-model retry sees rewritten history", async () => {
    const seen: number[] = [];
    let sawAnchor = false;
    let calls = 0;
    const events = collector();
    const result = await isolated(
      runTestAgent(history, {
        ...effectOverflowCompactionConfig(),
        events,
        llm: {
          resolveModel: () => Effect.succeed(model),
          run: (input, sink) =>
            Effect.promise(async () => {
              calls += 1;
              seen.push(input.messages.length);
              sawAnchor =
                calls === 2 &&
                input.messages.some((message) =>
                  message.parts.some(
                    (part) => part.type === "text" && part.text.includes("overflow checkpoint"),
                  ),
                );
              return calls === 1
                ? {
                    type: "error",
                    error: providerFailure("prompt is too long", {
                      failureClass: { kind: "overflow" },
                      contextOverflow: true,
                      retryable: false,
                    }),
                  }
                : completeModel(input, sink);
            }),
        },
      }),
    );

    expect(calls).toBe(2);
    expect(result.finishReason).toBe("stop");
    expect(result.compactionCount).toBe(1);
    expect(seen[1]).toBeLessThan(seen[0] ?? 0);
    expect(sawAnchor).toBe(true);
    // One overflow is one compaction attempt: the admission check before the retry never fires a second one.
    expect(events.named(RunEvents.CompactionStarted.name).map((data) => RunEvents.CompactionStarted.schema.parse(data).trigger))
      .toEqual(["yield"]);
  });

  it.each([
    { finishReason: "stop", inputTokens: 9_800, cacheReadTokens: 300 },
    { finishReason: "length", inputTokens: 9_900, cacheReadTokens: 0 },
  ])("recovers a silent $finishReason stop on the same model without fallback", async ({ finishReason, inputTokens, cacheReadTokens }) => {
    const events = collector();
    const seenModels: string[] = [];
    let compactedHistory = false;
    const result = await isolated(runTestAgent(history, {
      ...effectOverflowCompactionConfig(),
      events,
      llm: {
        resolveModel: () => Effect.succeed(model),
        run: (input, sink) => Effect.promise(async () => {
          seenModels.push(`${input.model.providerID}/${input.model.id}`);
          if (seenModels.length === 1) return {
            type: "stop" as const,
            evidence: {
              usage: { inputTokens, cacheReadTokens, outputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
              visibleOutput: false,
              finishReason,
              credential: null,
            },
          };
          compactedHistory = input.messages.some((message) => message.parts.some(
            (part) => part.type === "text" && part.text.includes("overflow checkpoint"),
          ));
          return completeModel(input, sink);
        }),
        classifyFailure: (facts) => {
          if (facts.error || facts.finishReason === finishReason) return { kind: "overflow" };
          return { kind: "terminal", reason: "transient_error", providerReason: "non_retryable" };
        },
      },
    }));

    expect(result.finishReason).toBe("stop");
    expect(result.compactionCount).toBe(1);
    expect(seenModels).toEqual(["provider/model", "provider/model"]);
    expect(compactedHistory).toBe(true);
    expect(events.named(RunEvents.ErrorRetry.name).map((data) => RunEvents.ErrorRetry.schema.parse(data)))
      .toMatchObject([{ attempt: 1, reason: "context_overflow" }]);
  });

  it("stops after the one compacting retry and preserves the second overflow", async () => {
    const first = providerFailure("prompt is too long on first call", {
      failureClass: { kind: "overflow" },
      contextOverflow: true,
      retryable: false,
    });
    const second = providerFailure("prompt is too long on second call", {
      failureClass: { kind: "overflow" },
      contextOverflow: true,
      retryable: false,
    });
    let calls = 0;
    const running = isolated(
      Effect.exit(
        runTestAgent(history, {
          ...effectOverflowCompactionConfig(),
          llm: overflowLlm(() => (++calls === 1 ? first : second)),
        }),
      ),
    );

    await expectSquashedCause(running, second);
    expect(calls).toBe(2);
  });
});
