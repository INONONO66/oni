import type { ChatFixture as ChatAgentConfig } from "../../helpers/chat-services";
import { describe, expect, it } from "bun:test";
import { Effect, type Scope } from "effect";
import { CompactionSession } from "../../../src/plugins/compaction/speculate";
import { applyThreshold, stateAtGrace } from "../../helpers/compaction-seam";
import type {} from "../../../src/core/types";
import { RunEvents } from "../../../src/core/turn";
import { Bus } from "../../helpers/bus";
import { captureBusEvents } from "../../helpers/bus-event";
import { isolated } from "../../helpers/isolated";
import { textMessage } from "../../helpers/messages";
import { CompactionRun } from "../../../src/plugins/compaction/policy";
import { collector } from "../../helpers/observation-collector";

const WINDOW = 1000;

function config(): ChatAgentConfig {
  return {
    events: Bus,
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    compaction: { contextWindowTokens: WINDOW, protectRecentMessages: 1 },
  };
}

function inFlightSession(
  started: Promise<void>,
  onSummarize?: () => void,
): Effect.Effect<CompactionSession, never, Scope.Scope> {
  return Effect.gen(function* () {
    const session = new CompactionSession({
      protectRecentMessages: 1,
      summarize: () => Effect.sync(() => onSummarize?.()).pipe(
        Effect.andThen(Effect.promise(() => started)),
        Effect.as("summary"),
      ),
    });
    yield* session.prepare(
      [
        textMessage("assistant", "evidence ".repeat(100), "session", "first"),
        textMessage("user", "tail", "session", "last"),
      ],
      70,
      60,
      WINDOW,
    );
    return session;
  });
}

describe("compaction apply seam deferral", () => {
  it.each(["yield", "overflow"] as const)("defers %s while speculation is below grace without a second summarizer", (reason) =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const release = Promise.withResolvers<void>();
          const entered = Promise.withResolvers<void>();
          let summaries = 0;
          const session = yield* inFlightSession(release.promise, () => { summaries += 1; entered.resolve(); });
          yield* Effect.promise(() => entered.promise).pipe(Effect.timeout("5 seconds"));
          const state = stateAtGrace(WINDOW, -1);
          const events = collector();
          try {
            const outcome = yield* new CompactionRun(
              { options: config().compaction, identity: { traceId: "trace", sessionId: state.sessionId }, events },
              session,
            ).maybeCompact(state, reason);
            expect(outcome).toBe("skipped");
            expect(summaries).toBe(1);
            expect(events.named(RunEvents.CompactionStarted.name)).toHaveLength(0);
          } finally {
            release.resolve();
            yield* session.settled();
          }
        }),
      ),
    ));

  it("defers the threshold trigger while a speculative cut is in flight below grace", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const release = Promise.withResolvers<void>();
          const session = yield* inFlightSession(release.promise);
          expect(session.inFlight()).toBe(true);
          const state = stateAtGrace(WINDOW, -1);
          const started = captureBusEvents(RunEvents.CompactionStarted);
          try {
            const outcome = yield* applyThreshold(state, config(), session);
            expect(outcome).toBe("skipped");
            expect(started.events).toHaveLength(0);
          } finally {
            started.unsubscribe();
            release.resolve();
            yield* session.settled();
          }
        }),
      ),
    ));

  it("runs the merge once the measured window reaches grace even with a cut in flight", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const release = Promise.withResolvers<void>();
          const session = yield* inFlightSession(release.promise);
          const state = stateAtGrace(WINDOW, 0);
          const started = captureBusEvents(RunEvents.CompactionStarted);
          try {
            const outcome = yield* applyThreshold(state, config(), session);
            yield* Effect.promise(() => started.done);
            expect(outcome).toBe("completed");
            expect(started.events[0]?.trigger).toBe("threshold");
          } finally {
            started.unsubscribe();
            release.resolve();
            yield* session.settled();
          }
        }),
      ),
    ));
});
