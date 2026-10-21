import { describe, expect, it, jest } from "bun:test";
import type { Message } from "@oni/protocol";
import { Cause, Effect, Exit, Fiber } from "effect";
import { AgentFailure } from "../../src/core/ports/failure";
import { Compaction, CompactionSession } from "../../src/plugins/compaction";
import type { SummarizationBudget } from "../../src/plugins/compaction/contract";
import { collector } from "../helpers/observation-collector";
import { messageSequence } from "../helpers/messages";
import { isolated } from "../helpers/isolated";

const sequence = messageSequence("spec-session", ` ${"filler ".repeat(40)}`);
function message(role: "user" | "assistant", text: string): Message.WithParts {
  return sequence[role](text);
}
function history(): Message.WithParts[] {
  return [
    message("user", "goal"),
    message("assistant", "work-1"),
    message("assistant", "work-2"),
    message("user", "tail"),
    message("assistant", "answer"),
  ];
}
const identity = { traceId: "trace", sessionId: "spec-session", runId: "run" };

interface CallCounter {
  count: number;
}

/** A speculation session whose summarizer counts its calls and answers `summary(call)`. */
function countingSession(summary: (call: number) => string): {
  session: CompactionSession;
  calls: CallCounter;
} {
  const calls: CallCounter = { count: 0 };
  const session = new CompactionSession({
    protectRecentMessages: 2,
    summarize: () =>
      Effect.sync(() => {
        calls.count += 1;
        return summary(calls.count);
      }),
  });
  return { session, calls };
}

/** Threshold-triggered compaction offered the session's warm candidate; the sync summarizer counts into `calls`. */
function compactWith(
  session: CompactionSession,
  messages: Message.WithParts[],
  calls?: CallCounter,
) {
  return Compaction.compact(
    messages,
    {
      contextWindowTokens: 1000,
      protectRecentMessages: 2,
      onSummarize: () =>
        Effect.sync(() => {
          if (calls) calls.count += 1;
          return "sync";
        }),
    },
    identity,
    collector(),
    { trigger: "threshold", measuredTokens: 800, candidate: session.candidate() },
  );
}

function prepareCandidate(session: CompactionSession, messages: Message.WithParts[]) {
  return Effect.gen(function* () {
    yield* session.prepare(messages, 70, 60, 1000);
    yield* session.settled();
  });
}

function preparedHistory(summary: (call: number) => string) {
  return Effect.gen(function* () {
    const messages = history();
    const { session, calls } = countingSession(summary);
    yield* prepareCandidate(session, messages);
    return { messages, session, calls };
  });
}

describe("run-scoped compaction speculation", () => {
  it("starts only at the prepare boundary", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { session, calls } = countingSession(() => "anchor");
          yield* session.prepare(history(), 59, 60, 1000);
          yield* session.settled();
          expect(calls.count).toBe(0);
          yield* session.prepare(history(), 60, 60, 1000);
          yield* session.settled();
          expect(calls.count).toBe(1);
        }),
      ),
    ));

  it("is single-flight and retains one candidate", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;
          const entered = Promise.withResolvers<void>();
          const releases: Array<(summary: string) => void> = [];
          const session = new CompactionSession({
            protectRecentMessages: 2,
            summarize: () =>
              Effect.promise(
                () =>
                  new Promise<string>((resolve: (summary: string) => void) => {
                    calls += 1;
                    releases.push(resolve);
                    entered.resolve();
                  }),
              ),
          });
          const messages = history();
          yield* session.prepare(messages, 70, 60, 1000);
          yield* session.started();
          yield* Effect.promise(() => entered.promise);
          yield* session.prepare(messages, 80, 60, 1000);
          for (const release of releases) release("candidate");
          yield* session.settled();
          yield* session.prepare(messages, 90, 60, 1000);
          yield* session.settled();
          expect(calls).toBe(1);
        }),
      ),
    ));

  it("a waiter from a preparation aborted before entry resolves on the next entry", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { session, calls } = countingSession(() => "candidate");
          const messages = history();
          yield* session.prepare(messages, 70, 60, 1000);
          // Same synchronous continuation: the forked preparation is interrupted before it starts.
          yield* session.abort();
          const waiter = yield* Effect.forkScoped(session.started(), { startImmediately: true });
          expect(calls.count).toBe(0);
          yield* session.prepare(messages, 80, 60, 1000);
          yield* session.settled();
          expect(calls.count).toBe(1);
          yield* Fiber.join(waiter);
        }),
      ),
    ));

  it("promotes a fresh candidate without another summary call", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { messages, session, calls } = yield* preparedHistory(() => "prepared");
          const result = yield* compactWith(session, messages, calls);
          expect(result.candidate).toBe("promoted");
          expect(calls.count).toBe(1);
        }),
      ),
    ));

  it("discards a changed prefix and falls back synchronously", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { messages, session, calls } = yield* preparedHistory(() => "prepared");
          const changed = structuredClone(messages);
          const part = changed[1]?.parts[0];
          if (part?.type !== "text") throw new Error("expected text fixture");
          part.text = "changed";
          const result = yield* compactWith(session, changed, calls);
          expect(result.candidate).toBe("discarded");
          expect(calls.count).toBe(2);
        }),
      ),
    ));

  it("promotes across appended turns and preserves the appended tail", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const messages = history();
          const { session, calls } = countingSession(() => "prefix-anchor");
          yield* session.prepare(messages, 70, 60, 1000);
          yield* session.settled();
          const grown = [...messages, message("user", "late-q"), message("assistant", "late-a")];
          const result = yield* compactWith(session, grown, calls);
          expect(result.candidate).toBe("promoted");
          expect(calls.count).toBe(1);
          expect(
            result.messages
              .flatMap((entry: Message.WithParts) => entry.parts)
              .some((part: Message.Part) => part.type === "text" && part.text.includes("late-q")),
          ).toBe(true);
        }),
      ),
    ));

  it("keeps a candidate valid when only a completed tool output changes", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const messages = history();
          const owner = messages[1];
          if (owner === undefined) throw new Error("expected assistant fixture");
          owner.parts.push({
            id: "tool-part",
            sessionID: "spec-session",
            messageID: owner.info.id,
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "completed",
              input: { path: "/tmp/a" },
              output: "large original output",
              title: "read",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          });
          const { session, calls } = countingSession(() => "tool-anchor");
          yield* session.prepare(messages, 70, 60, 1000);
          yield* session.settled();
          const changed = structuredClone(messages);
          const tool = changed[1]?.parts.find((part: Message.Part) => part.type === "tool");
          if (tool?.type !== "tool" || tool.state.status !== "completed") {
            throw new Error("expected completed tool fixture");
          }
          tool.state.output = "[output elided by compaction]";
          const result = yield* compactWith(session, changed, calls);
          expect(result.candidate).toBe("promoted");
          expect(calls.count).toBe(1);
        }),
      ),
    ));

  it("invalidates a warm candidate when a different compaction anchor lands", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { session, calls } = yield* preparedHistory((call) => `anchor-${call}`);
          const landed = message("user", "landed-compaction");
          const part = landed.parts[0];
          if (part?.type !== "text") throw new Error("expected text fixture");
          landed.parts = [{ ...part, metadata: { compactionAnchor: true, anchorBody: "other" } }];
          yield* session.prepare([landed, ...history()], 70, 60, 1000);
          yield* session.settled();
          expect(calls.count).toBe(2);
        }),
      ),
    ));

  it("replaces a stale candidate during the next background prepare", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { session, calls } = yield* preparedHistory((call) => `anchor-${call}`);
          const replacement = history();
          yield* session.prepare(replacement, 70, 60, 1000);
          yield* session.settled();
          const result = yield* compactWith(session, replacement);
          expect(calls.count).toBe(2);
          expect(result.candidate).toBe("promoted");
        }),
      ),
    ));

  it("recovers from a background prepare failure through the synchronous seam", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;
          const messages = history();
          const session = new CompactionSession({
            protectRecentMessages: 2,
            summarize: () =>
              Effect.sync(() => {
                calls += 1;
                if (calls === 1)
                  return Effect.fail(
                    new AgentFailure({ operation: "test", cause: "provider down" }),
                  );
                return Effect.succeed("recovered");
              }).pipe(Effect.flatten),
          });
          yield* session.prepare(messages, 70, 60, 1000);
          yield* session.settled();
          expect(session.candidate()).toBeUndefined();
          const result = yield* Compaction.compact(
            messages,
            {
              contextWindowTokens: 1000,
              protectRecentMessages: 2,
              onSummarize: () =>
                Effect.sync(() => {
                  calls += 1;
                  return "recovered";
                }),
            },
            identity,
            collector(),
            { trigger: "threshold", measuredTokens: 800, candidate: session.candidate() },
          );
          expect(result.compacted).toBe(true);
          expect(calls).toBe(2);
        }),
      ),
    ));

  it("falls back synchronously when a valid candidate cannot reclaim", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const tiny = [
            message("user", "q"),
            message("assistant", "a"),
            message("user", "t1"),
            message("user", "t2"),
          ];
          const { session, calls } = countingSession(() => "x".repeat(5000));
          yield* session.prepare(tiny, 70, 60, 1000);
          yield* session.settled();
          const grown = [
            ...tiny,
            ...Array.from({ length: 8 }, (_entry: undefined, index: number) =>
              message("assistant", `late-${index}`),
            ),
            message("user", "tail-q"),
            message("assistant", "tail-a"),
          ];
          const result = yield* compactWith(session, grown, calls);
          expect(result).toMatchObject({ candidate: "discarded", compacted: true });
          expect(calls.count).toBe(2);
        }),
      ),
    ));

  it("retains an unevaluated candidate after a protected-tail no-op", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const messages = history();
          const { session, calls } = countingSession(() => "kept-candidate");
          yield* session.prepare(messages, 70, 60, 1000);
          yield* session.settled();
          const short = yield* compactWith(session, messages.slice(0, 2));
          expect(short.candidate).toBeUndefined();
          const result = yield* compactWith(session, messages);
          expect(result.candidate).toBe("promoted");
          expect(calls.count).toBe(1);
        }),
      ),
    ));

  it("uses deterministic fallback when the summarizer deadline expires", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          jest.useFakeTimers();
          try {
            const entered = Promise.withResolvers<void>();
            const pending = Compaction.compact(
              history(),
              {
                contextWindowTokens: 1000,
                protectRecentMessages: 2,
                summarizerDeadlineMs: 100,
                onSummarize: (
                  _messages: Message.WithParts[],
                  _previous: string | undefined,
                  _budget: SummarizationBudget,
                  _signal: AbortSignal | undefined,
                ) => {
                  entered.resolve();
                  return Effect.never;
                },
              },
              identity,
              collector(),
              { trigger: "threshold", measuredTokens: 800 },
            );
            const pendingFiber = yield* Effect.forkChild(pending);
            yield* Effect.promise(() => entered.promise);
            jest.advanceTimersByTime(100);
            const result = yield* Fiber.join(pendingFiber);
            expect(result).toMatchObject({ compacted: true, summarizerFailed: true });
          } finally {
            jest.useRealTimers();
          }
        }),
      ),
    ));

  it("aborts before the scheduled summary starts", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { session, calls } = countingSession(() => "late");
          yield* session.prepare(history(), 70, 60, 1000);
          yield* session.abort();
          const settled = yield* Effect.exit(session.settled());
          expect(Exit.isFailure(settled) && Cause.hasInterruptsOnly(settled.cause)).toBe(true);
          expect(calls.count).toBe(0);
          expect(session.candidate()).toBeUndefined();
        }),
      ),
    ));

  it("aborts an active summary through its exact signal", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = Promise.withResolvers<void>();
          const aborted = Promise.withResolvers<void>();
          const session = new CompactionSession({
            protectRecentMessages: 2,
            summarize: () =>
              Effect.promise(
                (signal: AbortSignal) =>
                  new Promise<string>(() => {
                    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
                    entered.resolve();
                  }),
              ),
          });
          yield* session.prepare(history(), 70, 60, 1000);
          yield* Effect.promise(() => entered.promise);
          yield* session.abort();
          yield* Effect.promise(() => aborted.promise);
          const settled = yield* Effect.exit(session.settled());
          expect(Exit.isFailure(settled) && Cause.hasInterruptsOnly(settled.cause)).toBe(true);
          expect(session.candidate()).toBeUndefined();
        }),
      ),
    ));

  it("stops preparing after two failures", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;
          const session = new CompactionSession({
            protectRecentMessages: 2,
            summarize: () =>
              Effect.suspend(() => {
                calls += 1;
                return Effect.fail(
                  new AgentFailure({ operation: "test", cause: "provider down" }),
                );
              }),
          });
          for (let attempt = 0; attempt < 3; attempt += 1) {
            yield* session.prepare(history(), 70, 60, 1000);
            yield* session.settled();
          }
          expect(calls).toBe(2);
        }),
      ),
    ));
});
