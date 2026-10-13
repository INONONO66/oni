import { expect, test } from "bun:test";
import { Core } from "@openomni/agent";
import { Clock, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { z } from "zod";
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { createCompactionSummarizer } from "../src/bundles/compaction/summarizer";
import { assistantMessage } from "./helpers/assistant-message";
import { runEffect } from "./helpers/effect";
import { residentRunner } from "./helpers/resident-runner";
import { testIds } from "./helpers/test-entropy";

const SUMMARY_USAGE = {
  inputTokens: 17,
  outputTokens: 11,
  reasoningTokens: 2,
  cacheReadTokens: 7,
  cacheWriteTokens: 3,
};
const SummaryIntent = z.object({
  phase: z.literal("intent"),
  attempt: z.number(),
  value: z.object({ purpose: z.literal("compaction") }),
});
const CompactionResult = z.object({
  phase: z.literal("result"),
  terminal: z.literal("executed"),
  result: z.object({ summarizerFailed: z.literal(true) }),
});

test.each(["success", "throws", "timeout"] as const)(
  "summary %s stays in the compacting session and completes the turn",
  async (outcome) => {
    await runEffect(Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const entered = yield* Deferred.make<void>();
      const sessionId = `summary-${outcome}`;
      const requests: Core.RunInput[] = [];
      const summaries: Core.RunInput[] = [];
      let constrained = false;
      let calls = 0;
      let cancelled = false;
      const resident = residentRunner({
        model: { provider: "fake", id: "resident-test" },
        apiKey: "test-key",
        tools: {},
        compaction: (session) => createCompactionSummarizer({
          ...session,
          now: () => 1000,
          id: testIds(sessionId),
          model: { provider: "fake", id: "summary-test", apiKey: "test-key" },
        }).pipe(Effect.map((summarize) => ({
          contextWindowTokens: constrained ? 700 : 100_000,
          // Exercise the synchronous cut, not background candidate promotion.
          speculate: false,
          onSummarize: (...args) => summarize(...args).pipe(Effect.provideService(Clock.Clock, clock)),
        }))),
        llm: {
          resolveModel: (model) => Effect.succeed({
            id: model.id, name: model.id, providerID: model.provider,
            limit: { context: constrained ? 700 : 100_000 },
          }),
          run: (input, sink) => Effect.suspend(() => {
            if (input.model.id === "summary-test") {
              summaries.push(input);
              switch (outcome) {
                case "throws":
                  return Effect.sync(() => {
                    throw new Core.AgentFailure({ operation: "fixture.summary", cause: "provider threw" });
                  });
                case "timeout":
                  return Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Effect.sync(() => { cancelled = true; })),
                  );
                case "success":
                  sink.onMessage(assistantMessage(input, { text: "retained decisions" }));
                  return Effect.succeed({
                    type: "stop",
                    evidence: {
                      usage: SUMMARY_USAGE, usageProvenance: "reported",
                      visibleOutput: true, finishReason: "stop", credential: null,
                    },
                  });
              }
            }
            calls += 1;
            if (constrained) requests.push(input);
            sink.onMessage(assistantMessage(input, {
              call: calls,
              text: `answer ${calls} ${"filler ".repeat(30)}`,
              reason: constrained && requests.length === 1 ? "tool-calls" : "stop",
              ...(constrained ? { tokens: { input: 650, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } : {}),
            }));
            return Effect.succeed({ type: "stop" });
          }),
        },
      });
      for (let index = 0; index < 6; index += 1) {
        yield* Effect.promise(() => resident.prompt(sessionId, `question ${index} ${"filler ".repeat(30)}`));
      }
      constrained = true;
      const turn = yield* Effect.promise(() => resident.prompt(sessionId, "compact now")).pipe(Effect.forkChild);
      if (outcome === "timeout") {
        yield* Deferred.await(entered);
        yield* TestClock.adjust(60_000);
      }
      const terminal = yield* Fiber.join(turn);
      const actions = sessionTree(sessionId, resident.plane.sessionStore(sessionId).actions);
      expect(terminal).toMatchObject({ kind: "result" });
      const attempts = actions.filter((action) => action.kind === "llm" && SummaryIntent.safeParse(action.intent.value).success);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.sessionId).toBe(sessionId);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.trace.sessionId).toBe(sessionId);
      expect(summaries[0]?.system).toBe(requests[0]?.system);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.messages.length).toBeLessThan(requests[0]?.messages.length ?? 0);
      expect(resident.plane.listSessions().map((row) => row.id)).toEqual([sessionId]);
      const turns = resident.plane.openKernel(sessionId).getSnapshot(sessionId).turns;
      expect(turns.at(-1)?.terminal?.kind).toBe("result");
      expect(turns.some((turnRow) => turnRow.terminal?.kind === "error")).toBe(false);
      const result = actions.find((action) => action.kind === "llm" && action.parentId === attempts[0]?.id);
      if (outcome === "success") {
        expect(result?.effect.value).toMatchObject({
          phase: "result", terminal: "executed", usageProvenance: "reported",
          evidence: { usage: SUMMARY_USAGE },
        });
      } else {
        expect(actions.some((action) => action.kind === "compaction" && CompactionResult.safeParse(action.effect.value).success)).toBe(true);
        expect(cancelled).toBe(outcome === "timeout");
      }
    }).pipe(Effect.provide(TestClock.layer())));
  },
);
