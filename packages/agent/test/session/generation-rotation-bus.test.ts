import { describe, expect, it } from "bun:test";
import { BusEvent } from "@oni/protocol";
import { Deferred, Effect, Exit, Scope, Stream } from "effect";
import { z } from "zod";
import { makeObservationBus, type ObservationBus } from "../../src/core/observation/bus";
import { runTestPromise } from "../helpers/isolated";

const TestEvent = BusEvent.define(
  "test.session.generation_rotation",
  z.object({ sessionId: z.string(), value: z.number() }),
);

/** A generation-shaped subscriber: a Stream drain owned by that generation's Scope. */
const generationSubscriber = (
  bus: ObservationBus,
  generationScope: Scope.Closeable,
  seen: number[],
  signal: (value: number) => Effect.Effect<boolean>,
) =>
  Effect.gen(function* () {
    const stream = yield* bus.stream(TestEvent).pipe(Scope.provide(generationScope));
    yield* Stream.runForEach(stream, (data) =>
      Effect.suspend(() => {
        seen.push(data.value);
        return signal(data.value);
      })).pipe(Effect.forkIn(generationScope));
  });

describe("generation rotation over the observation bus", () => {
  it("overlapping generations unsubscribe independently: closing the old Scope ends only its subscriber", () =>
    runTestPromise(Effect.scoped(Effect.gen(function* () {
      const bus = yield* makeObservationBus({ id: () => "rotation-event", now: () => 1 });
      const generationOne = yield* Scope.make();
      const generationTwo = yield* Scope.make();
      const seenOne: number[] = [];
      const seenTwo: number[] = [];
      const oneGotFirst = yield* Deferred.make<void>();
      const oneGotSecond = yield* Deferred.make<void>();
      const twoGotSecond = yield* Deferred.make<void>();
      const twoGotThird = yield* Deferred.make<void>();

      yield* generationSubscriber(bus, generationOne, seenOne, (value) =>
        value === 1 ? Deferred.succeed(oneGotFirst, void 0) : Deferred.succeed(oneGotSecond, void 0));
      bus.sink.publish(TestEvent, { sessionId: "session-r", value: 1 });
      yield* Deferred.await(oneGotFirst);

      // Overlap: generation two subscribes while generation one is still live.
      yield* generationSubscriber(bus, generationTwo, seenTwo, (value) =>
        value === 2 ? Deferred.succeed(twoGotSecond, void 0) : Deferred.succeed(twoGotThird, void 0));
      bus.sink.publish(TestEvent, { sessionId: "session-r", value: 2 });
      yield* Deferred.await(oneGotSecond);
      yield* Deferred.await(twoGotSecond);

      // Rotation: generation one closes; its subscription is removed at Scope
      // closure, so event 3 is never enqueued for it — no timing involved.
      yield* Scope.close(generationOne, Exit.void);
      bus.sink.publish(TestEvent, { sessionId: "session-r", value: 3 });
      yield* Deferred.await(twoGotThird);

      expect(seenOne).toEqual([1, 2]);
      expect(seenTwo).toEqual([2, 3]);
      yield* Scope.close(generationTwo, Exit.void);
    }))));
});
