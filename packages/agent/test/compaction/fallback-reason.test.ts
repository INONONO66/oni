import { expect, test } from "bun:test";
import { Journal } from "@openomni/protocol";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { AgentFailure } from "../../src/core/ports/failure";
import { isolated } from "../helpers/isolated";
import { recoveryRecording } from "../helpers/effect-g3r";
import { runTestAgent } from "../helpers/effect-g3";
import { overflowThenCompleteLlm } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";

test.each(["failure", "deadline"] as const)(
  "summary %s records fallback and preserves the trigger before a successful continuation",
  (mode) => isolated(Effect.gen(function* () {
    const recording = recoveryRecording();
    const entered = yield* Deferred.make<void>();
    let cancelled = false;
    const overflow = overflowThenCompleteLlm();
    const run = yield* Effect.forkChild(runTestAgent(
      runInput([
        { role: "user", content: "goal" },
        { role: "assistant", content: "prior evidence ".repeat(100) },
        { role: "user", content: "continue" },
      ]),
      {
        events: { publish: () => undefined },
        executor: recording.executor,
        model: { provider: "provider", id: "model" },
        compaction: {
          contextWindowTokens: 1000,
          protectRecentMessages: 1,
          speculate: false,
          summarizerDeadlineMs: 100,
          onSummarize: () => mode === "failure"
            ? Effect.fail(new AgentFailure({ operation: "summary", cause: "unavailable" }))
            : Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Effect.sync(() => { cancelled = true; })),
            ),
        },
        llm: overflow.llm,
      },
    ));
    if (mode === "deadline") {
      yield* Deferred.await(entered);
      yield* TestClock.adjust(100);
    }
    const terminal = yield* Fiber.join(run);
    expect(terminal.finishReason).toBe("stop");
    expect(overflow.calls).toBe(2);
    expect(cancelled).toBe(mode === "deadline");
    const rows = recording.committed.filter((action) => action.kind === "compaction");
    const result = rows.find((action) => "revert" in action);
    expect(result?.effect.value).toMatchObject({
      phase: "result", terminal: "executed",
      result: { reason: "fallback", summarizerFailed: true },
    });
    const intent = rows.find((action) => action.id === result?.parentId);
    expect(intent?.intent.value).toMatchObject({ value: { trigger: "yield" } });
    expect(Journal.declarationFor("compaction")?.schema.safeParse({
      intent: result?.intent, effect: result?.effect,
    }).success).toBe(true);
  }).pipe(Effect.provide(TestClock.layer()))),
);
