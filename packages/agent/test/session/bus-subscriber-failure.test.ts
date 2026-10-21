import { describe, expect, it } from "bun:test";
import { BusEvent } from "@oni/protocol";
import { Effect, Logger } from "effect";
import { z } from "zod";
import { ObservationSubscriberFailure, makeObservationBus } from "../../src/core/observation/bus";
import { bounded } from "../helpers/bounded";
import { runTestPromise } from "../helpers/isolated";

const TestEvent = BusEvent.define(
  "test.session.subscriber_failure",
  z.object({ sessionId: z.string(), value: z.number() }),
);

/** Captures the first ObservationSubscriberFailure the bus logs. */
function failureCollector(resolve: (failure: ObservationSubscriberFailure) => void) {
  return Logger.make((options) => {
    for (const item of Array.isArray(options.message) ? options.message : [options.message]) {
      if (item instanceof ObservationSubscriberFailure) resolve(item);
    }
  });
}

describe("bus subscriber failure", () => {
  it("a throwing subscriber is logged as a typed failure and never blocks publication or other subscribers", async () => {
    const logged = Promise.withResolvers<ObservationSubscriberFailure>();
    const failingContinued = Promise.withResolvers<number>();
    const healthySecond = Promise.withResolvers<number>();
    const healthySaw: number[] = [];
    const failingSaw: number[] = [];

    await runTestPromise(
      Effect.scoped(Effect.gen(function* () {
        const bus = yield* makeObservationBus({ id: () => "failure-event", now: () => 1 });
        const stopFailing = bus.sink.subscribe(TestEvent, (data) => {
          if (data.value === 1) throw new Error("subscriber exploded");
          failingSaw.push(data.value);
          failingContinued.resolve(data.value);
        });
        const stopHealthy = bus.sink.subscribe(TestEvent, (data) => {
          healthySaw.push(data.value);
          if (data.value === 2) healthySecond.resolve(data.value);
        });

        // The publisher is synchronous: the throw lands on the subscriber's
        // fiber and publish returns before any delivery happens.
        bus.sink.publish(TestEvent, { sessionId: "session-f", value: 1 });
        const failure = yield* Effect.promise(() => bounded(logged.promise, "logged typed failure"));
        expect(failure.eventName).toBe(TestEvent.name);
        expect(failure.cause).toContain("subscriber exploded");

        // Publication continues and the failing subscriber's stream survived.
        bus.sink.publish(TestEvent, { sessionId: "session-f", value: 2 });
        yield* Effect.promise(() => bounded(failingContinued.promise, "failing subscriber continued"));
        yield* Effect.promise(() => bounded(healthySecond.promise, "healthy subscriber second delivery"));
        stopFailing();
        stopHealthy();
      })).pipe(Effect.provide(Logger.layer([failureCollector(logged.resolve)]))),
    );

    expect(failingSaw).toEqual([2]);
    expect(healthySaw).toEqual([1, 2]);
  });
});
