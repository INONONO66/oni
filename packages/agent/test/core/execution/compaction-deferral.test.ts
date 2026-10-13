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
): Effect.Effect<CompactionSession, never, Scope.Scope> {
  return Effect.gen(function* () {
    const session = new CompactionSession({
      protectRecentMessages: 1,
      summarize: () => Effect.promise(() => started).pipe(Effect.as("summary")),
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
