/**
 * #1305 bus interest gate: a publish with zero matching subscriber interest
 * for that event name enqueues nothing — the payload never reaches the
 * PubSub — and the decision is observable through the `onPublish` seam
 * rung 16 measures with. Wildcard `observations` counts for every name.
 */
import { describe, expect, it } from "bun:test";
import { BusEvent } from "@openomni/protocol";
import { Deferred, Effect, Exit, Scope, Stream } from "effect";
import { z } from "zod";
import { interestBus, publishUntilDelivered, yieldUntil, type InterestBus } from "../helpers/bus-fixture";
import { runTestPromise } from "../helpers/isolated";

const TestEvent = BusEvent.define(
  "test.bus.interest",
  z.object({ sessionId: z.string(), value: z.number() }),
);
const OtherEvent = BusEvent.define(
  "test.bus.other",
  z.object({ sessionId: z.string(), value: z.number() }),
);

/** One fresh bus + collector per case, released with the case's Scope. */
const busCase = (body: (fixture: InterestBus) => Effect.Effect<void, never, Scope.Scope>) =>
  runTestPromise(Effect.scoped(interestBus().pipe(Effect.flatMap(body))));

describe("observation bus interest (#1305)", () => {
  it("zero subscribers: publish is skipped, reported through onPublish, and nothing is retained", () =>
    busCase(({ bus, published }) =>
      Effect.gen(function* () {
        bus.sink.publish(TestEvent, { sessionId: "session-1", value: 1 });
        expect(published).toEqual([{ name: TestEvent.name, delivered: false }]);

        // A subscriber arriving later sees nothing of the skipped publish:
        // the zero-interest drop is permanent, exactly like PubSub's own
        // no-subscription drop.
        const seen: number[] = [];
        const got = yield* Deferred.make<void>();
        const stream = yield* bus.stream(TestEvent);
        yield* Effect.forkScoped(
          Stream.runForEach(stream, (data) =>
            Effect.suspend(() => {
              seen.push(data.value);
              return Deferred.succeed(got, void 0);
            }),
          ),
        );
        bus.sink.publish(TestEvent, { sessionId: "session-1", value: 2 });
        yield* Deferred.await(got);
        expect(seen).toEqual([2]);
        expect(published).toEqual([
          { name: TestEvent.name, delivered: false },
          { name: TestEvent.name, delivered: true },
        ]);
      }),
    ));

  it("interest ends with the subscriber's Scope: publishes skip again after closure", () =>
    busCase(({ bus, published }) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* bus.stream(TestEvent).pipe(Scope.provide(scope));
        bus.sink.publish(TestEvent, { sessionId: "session-1", value: 1 });
        expect(published.at(-1)).toEqual({ name: TestEvent.name, delivered: true });

        yield* Scope.close(scope, Exit.void);
        bus.sink.publish(TestEvent, { sessionId: "session-1", value: 2 });
        expect(published.at(-1)).toEqual({ name: TestEvent.name, delivered: false });
      }),
    ));

  it("interest is per event name: a subscriber for A alone drops a publish of B", () =>
    busCase(({ bus, published }) =>
      Effect.gen(function* () {
        yield* bus.stream(TestEvent);
        bus.sink.publish(OtherEvent, { sessionId: "session-1", value: 1 });
        bus.sink.publish(TestEvent, { sessionId: "session-1", value: 2 });
        expect(published).toEqual([
          { name: OtherEvent.name, delivered: false },
          { name: TestEvent.name, delivered: true },
        ]);
      }),
    ));

  it("wildcard observations registers interest for every event name", () =>
    busCase(({ bus, published }) =>
      Effect.gen(function* () {
        yield* bus.observations;
        bus.sink.publish(OtherEvent, { sessionId: "session-1", value: 1 });
        bus.sink.publish(TestEvent, { sessionId: "session-1", value: 2 });
        expect(published).toEqual([
          { name: OtherEvent.name, delivered: true },
          { name: TestEvent.name, delivered: true },
        ]);
      }),
    ));

  it("callback subscribers count as interest for the drain's lifetime", () =>
    busCase(({ bus, published }) =>
      Effect.gen(function* () {
        const got = Promise.withResolvers<number>();
        const unsubscribe = bus.sink.subscribe(TestEvent, (data) => got.resolve(data.value));
        // Await actual interest, not timing: subscribe forks its drain, so
        // publish only counts as delivered once the subscription is live.
        yield* publishUntilDelivered({ bus, published }, () =>
          bus.sink.publish(TestEvent, { sessionId: "session-1", value: 7 }),
        );
        expect(yield* Effect.promise(() => got.promise)).toBe(7);
        unsubscribe();
      }),
    ));
});

describe("observation bus subscriberCount (#1314)", () => {
  it("rises per live subscription and falls to zero at Scope close", () =>
    busCase(({ bus }) =>
      Effect.gen(function* () {
        expect(bus.subscriberCount()).toBe(0);
        const scope = yield* Scope.make();
        yield* bus.stream(TestEvent).pipe(Scope.provide(scope));
        expect(bus.subscriberCount()).toBe(1);
        yield* bus.observations.pipe(Scope.provide(scope));
        expect(bus.subscriberCount()).toBe(2);
        yield* Scope.close(scope, Exit.void);
        expect(bus.subscriberCount()).toBe(0);
      }),
    ));

  it("counts a callback drain for its lifetime and never alters publication", () =>
    busCase(({ bus, published }) =>
      Effect.gen(function* () {
        const got = Promise.withResolvers<number>();
        const unsubscribe = bus.sink.subscribe(TestEvent, (data) => got.resolve(data.value));
        // Await actual interest, not timing (same seam as the #1305 tests).
        yield* publishUntilDelivered({ bus, published }, () =>
          bus.sink.publish(TestEvent, { sessionId: "session-1", value: 3 }),
        );
        expect(bus.subscriberCount()).toBe(1);
        expect(yield* Effect.promise(() => got.promise)).toBe(3);
        unsubscribe();
        yield* yieldUntil(() => bus.subscriberCount() === 0);
        expect(bus.subscriberCount()).toBe(0);
      }),
    ));
});
