import { describe, expect, it } from "bun:test";
import { BusEvent } from "@oni/protocol";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { z } from "zod";
import { makeObservationBus } from "../../src/core/observation/bus";
import { runTestPromise } from "../helpers/isolated";

const TestEvent = BusEvent.define(
  "test.session.bus",
  z.object({ sessionId: z.string(), value: z.number() }),
);

/** Deterministic injected sources: counter ids, counter times. */
function sources() {
  let n = 0;
  return { id: () => `event-${++n}`, now: () => ++n };
}

describe("session bus PubSub delivery", () => {
  it("delivers to every live subscriber; a closed subscriber Scope receives nothing after closure", () =>
    runTestPromise(Effect.scoped(Effect.gen(function* () {
      const bus = yield* makeObservationBus(sources());
      const scopeA = yield* Scope.make();
      const scopeB = yield* Scope.make();
      const seenA: number[] = [];
      const seenB: number[] = [];
      const aGotFirst = yield* Deferred.make<void>();
      const bGotFirst = yield* Deferred.make<void>();
      const bGotSecond = yield* Deferred.make<void>();
      const streamA = yield* bus.stream(TestEvent).pipe(Scope.provide(scopeA));
      const streamB = yield* bus.stream(TestEvent).pipe(Scope.provide(scopeB));
      const drainA = yield* Effect.forkScoped(Stream.runForEach(streamA, (data) =>
        Effect.sync(() => {
          seenA.push(data.value);
        }).pipe(Effect.andThen(Deferred.succeed(aGotFirst, void 0)))));
      yield* Effect.forkScoped(Stream.runForEach(streamB, (data) =>
        Effect.suspend(() => {
          seenB.push(data.value);
          return data.value === 2
            ? Deferred.succeed(bGotSecond, void 0)
            : Deferred.succeed(bGotFirst, void 0);
        })));

      bus.sink.publish(TestEvent, { sessionId: "session-1", value: 1 });
      yield* Deferred.await(aGotFirst);
      yield* Deferred.await(bGotFirst);

      // Closing A's Scope removes its subscription before the next publish,
      // so event 2 is never enqueued for A — no timing involved.
      yield* Scope.close(scopeA, Exit.void);
      bus.sink.publish(TestEvent, { sessionId: "session-1", value: 2 });
      yield* Deferred.await(bGotSecond);

      expect(seenA).toEqual([1]);
      expect(seenB).toEqual([1, 2]);
      yield* Fiber.interrupt(drainA);
    }))));

  it("publish is synchronous and nonblocking with an undrained subscriber; the queue survives to the drain", () =>
    runTestPromise(Effect.scoped(Effect.gen(function* () {
      const bus = yield* makeObservationBus(sources());
      // The subscription exists but nothing takes from it until the batch is
      // fully published: the synchronous loop below completes only if publish
      // never suspends, and the drain afterwards proves no queued value was
      // dropped while unconsumed.
      const queued = yield* bus.stream(TestEvent);
      for (let value = 0; value < 1000; value += 1) {
        bus.sink.publish(TestEvent, { sessionId: "session-slow", value });
      }
      const received = yield* Stream.runCollect(queued.pipe(Stream.take(1000)));
      expect(received.map((data) => data.value)).toEqual(
        Array.from({ length: 1000 }, (_, value) => value),
      );
    }))));

  it("match-filtered Streams see only payloads whose fields all match", () =>
    runTestPromise(Effect.scoped(Effect.gen(function* () {
      const bus = yield* makeObservationBus(sources());
      const matched = yield* bus.stream(TestEvent, { match: { sessionId: "session-1" } });
      bus.sink.publish(TestEvent, { sessionId: "session-1", value: 1 });
      bus.sink.publish(TestEvent, { sessionId: "session-2", value: 2 });
      bus.sink.publish(TestEvent, { sessionId: "session-1", value: 3 });
      const received = yield* Stream.runCollect(matched.pipe(Stream.take(2)));
      expect(received.map((data) => data.value)).toEqual([1, 3]);
    }))));
});
