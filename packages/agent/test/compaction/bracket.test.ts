import { Cause, Effect, Exit, Option, Result } from "effect";
import { providerFailure } from "../helpers/mock-llm";
import { isolated } from "../helpers/isolated";
import { afterEach, describe, expect, it } from "bun:test";
import type { BusEvent } from "@openomni/protocol";
import { RunEvents } from "../../src/core/turn";
import { Bus } from "../helpers/bus";
import { collector } from "../helpers/observation-collector";
import { Compaction } from "../../src/plugins/compaction/compact";
import { captureBusEvents } from "../helpers/bus-event";

import { messageSequence } from "../helpers/messages";

// Every compaction has one start and one terminal event, including failures.

const IDENTITY = {
  traceId: "trace-bracket-test",
  sessionId: "session-bracket-test",
  runId: "run-bracket-test",
  actorId: "actor-bracket-test",
} as const;

const { user: makeUserMessage, assistant: makeAssistantMessage } = messageSequence(
  IDENTITY.sessionId,
);

interface StartedEvent {
  traceId: string;
  sessionId: string;
  runId?: string;
  actorId?: string;
  messagesBefore: number;
  trigger: string;
  summarizer: boolean;
}

interface CompletedEvent {
  traceId: string;
  sessionId: string;
  runId?: string;
  actorId?: string;
  outcome: string;
  messagesBefore: number;
  messagesAfter: number;
  removedCount: number;
  elidedChars: number;
  error?: string;
}

function captureBracket(): {
  started: StartedEvent[];
  completed: CompletedEvent[];
  order: string[];
  done: Promise<void>;
  unsubscribe: () => void;
} {
  const order: string[] = [];
  const started = captureBusEvents(RunEvents.CompactionStarted, 1, () => order.push("started"));
  const completed = captureBusEvents(RunEvents.CompactionCompleted, 1, () =>
    order.push("completed"),
  );
  return {
    started: started.events as StartedEvent[],
    completed: completed.events as CompletedEvent[],
    order,
    done: Promise.all([started.done, completed.done]).then(() => undefined),
    unsubscribe: () => {
      started.unsubscribe();
      completed.unsubscribe();
    },
  };
}

describe("Compaction bracket", () => {
  afterEach(() => {
    Bus.reset();
  });

  it("brackets a cut: one started, one completed(cut), completed last", async () => {
    const capture = captureBracket();
    try {
      const result = await isolated(
        Compaction.compact(
          Array.from({ length: 12 }, (_unused: undefined, index: number) =>
            makeUserMessage(`message ${index}`),
          ),
          { contextWindowTokens: 1000, protectRecentMessages: 2 },
          IDENTITY,
          Bus,
          { trigger: "threshold" },
        ),
      );
      await capture.done;

      expect(result.compacted).toBe(true);
      expect(capture.started).toHaveLength(1);
      expect(capture.completed).toHaveLength(1);
      expect(capture.order).toEqual(["started", "completed"]);
      expect(capture.started[0]).toMatchObject({
        traceId: IDENTITY.traceId,
        sessionId: IDENTITY.sessionId,
        messagesBefore: 12,
        trigger: "threshold",
        summarizer: false,
      });
      expect(capture.completed[0]).toMatchObject({
        traceId: IDENTITY.traceId,
        sessionId: IDENTITY.sessionId,
        outcome: "cut",
      });
      // When the caller supplies a runId, the bracket records it.
      expect(capture.started[0]?.runId).toBe(IDENTITY.runId);
      expect(capture.completed[0]?.runId).toBe(IDENTITY.runId);
      // Attribution survives the schema boundary: the compaction bracket
      // carries the run's actorId like every other run-loop publisher.
      expect(capture.started[0]?.actorId).toBe(IDENTITY.actorId);
      expect(capture.completed[0]?.actorId).toBe(IDENTITY.actorId);
      expect(capture.completed[0]?.removedCount).toBeGreaterThan(0);
    } finally {
      capture.unsubscribe();
    }
  });

  it("records a failed terminal when publishing the normal completion throws", async () => {
    const events = collector();
    const publishError = new Error("completion append failed");
    const sink: BusEvent.Sink = {
      publish<T>(descriptor: BusEvent.Descriptor<T>, data: T) {
        if (
          descriptor === RunEvents.CompactionCompleted &&
          (data as { outcome?: string }).outcome !== "failed"
        ) {
          throw publishError;
        }
        events.publish(descriptor, data);
      },
    };

    const exit = await isolated(
      Effect.exit(
        Compaction.compact(
          Array.from({ length: 12 }, (_unused: undefined, index: number) =>
            makeUserMessage(`message ${index}`),
          ),
          { contextWindowTokens: 1000, protectRecentMessages: 2 },
          IDENTITY,
          sink,
          { trigger: "threshold" },
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error("expected completion publishing to fail");
    expect(Option.getOrThrow(Result.getSuccess(Cause.findDefect(exit.cause)))).toBe(publishError);

    expect(events.named(RunEvents.CompactionCompleted.name)).toHaveLength(1);
    expect(events.named(RunEvents.CompactionCompleted.name)[0]).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("completion append failed"),
    });
  });

  it("a summarizer throw degrades to a recorded skip — the run lives (#734 F1)", async () => {
    const capture = captureBracket();
    try {
      // Mixed roles: user messages never reach the summarizer (L2), so an
      // all-user span would skip the summarize call this test needs to fail.
      const result = await isolated(
        Compaction.compact(
          Array.from({ length: 12 }, (_unused: undefined, index: number) =>
            index % 2 === 0
              ? makeUserMessage(`message ${index}`)
              : makeAssistantMessage(`a${index}`),
          ),
          {
            contextWindowTokens: 1000,
            protectRecentMessages: 2,
            onSummarize: () => Effect.fail(providerFailure("summarizer exploded")),
          },
          IDENTITY,
          Bus,
          { trigger: "threshold" },
        ),
      );
      await capture.done;

      // Housekeeping failed; the run did not: no throw, the cut degraded
      // once to the no-summarizer snap-cut, and the record names it.
      expect(result.summarizerFailed).toBe(true);
      expect(result.compacted).toBe(true);
      expect(result.messages[0]?.info.role).toBe("user");
      expect(capture.started).toHaveLength(1);
      expect(capture.completed).toHaveLength(1);
      expect(String(capture.completed[0]?.error)).toContain("summarizer exploded");
      expect(capture.order).toEqual(["started", "completed"]);
    } finally {
      capture.unsubscribe();
    }
  });

  it("brackets the refused cut: completed(no_user_boundary)", async () => {
    const capture = captureBracket();
    try {
      const result = await isolated(
        Compaction.compact(
          Array.from({ length: 12 }, (_unused: undefined, index: number) =>
            makeAssistantMessage(`assistant ${index}`),
          ),
          { contextWindowTokens: 1000, protectRecentMessages: 2 },
          IDENTITY,
          Bus,
          { trigger: "yield" },
        ),
      );
      await capture.done;

      expect(result.compacted).toBe(false);
      expect(result.blocked).toBe("no_user_boundary");
      expect(capture.started).toHaveLength(1);
      expect(capture.started[0]?.trigger).toBe("yield");
      expect(capture.completed).toHaveLength(1);
      expect(capture.completed[0]?.outcome).toBe("no_user_boundary");
    } finally {
      capture.unsubscribe();
    }
  });

  it("brackets the trivial no-op: completed(nothing_reclaimed)", async () => {
    const capture = captureBracket();
    try {
      const result = await isolated(
        Compaction.compact(
          [makeUserMessage("only one")],
          { contextWindowTokens: 1000, protectRecentMessages: 6 },
          IDENTITY,
          Bus,
          { trigger: "threshold" },
        ),
      );
      await capture.done;

      expect(result.compacted).toBe(false);
      expect(capture.started).toHaveLength(1);
      expect(capture.completed).toHaveLength(1);
      expect(capture.completed[0]?.outcome).toBe("nothing_reclaimed");
    } finally {
      capture.unsubscribe();
    }
  });
});
