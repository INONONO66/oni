import { describe, expect, it } from "bun:test";
import { BusEvent } from "@openomni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { ObservationSink } from "../../src/core/ports/ports";
import { observationBusLayer } from "../../src/core/observation/bus";
import { bounded } from "../helpers/bounded";
import { runTestPromise } from "../helpers/isolated";

const TestEvent = BusEvent.define(
  "test.session.bus_layer",
  z.object({ sessionId: z.string(), value: z.number() }),
);

describe("observation bus as a Layer", () => {
  it("provides a working ObservationSink: callback subscribe receives publishes, match filters apply", async () => {
    const matched = Promise.withResolvers<number>();
    await runTestPromise(
      Effect.gen(function* () {
        const sink = yield* ObservationSink;
        const stop = sink.subscribe(
          TestEvent,
          (data) => matched.resolve(data.value),
          { match: { sessionId: "session-1" } },
        );
        sink.publish(TestEvent, { sessionId: "session-2", value: 1 });
        sink.publish(TestEvent, { sessionId: "session-1", value: 2 });
        yield* Effect.promise(() => bounded(matched.promise, "matched delivery"));
        stop();
      }).pipe(Effect.provide(observationBusLayer({ id: () => "layer-event", now: () => 7 }))),
    );
    expect(await matched.promise).toBe(2);
  });

  it("scope() stamps identity and the injected id/time sources onto every publish", async () => {
    const stamped = Promise.withResolvers<{ sessionId: string; value: number }>();
    let ids = 0;
    await runTestPromise(
      Effect.gen(function* () {
        const sink = yield* ObservationSink;
        const stop = sink.subscribe(TestEvent, stamped.resolve);
        const scoped = sink.scope({ sessionId: "session-9" });
        scoped.publish(TestEvent, { sessionId: "session-9", value: 3 });
        yield* Effect.promise(() => bounded(stamped.promise, "scoped delivery"));
        stop();
      }).pipe(Effect.provide(observationBusLayer({ id: () => `id-${++ids}`, now: () => 42 }))),
    );
    expect(await stamped.promise).toMatchObject({
      sessionId: "session-9",
      value: 3,
      eventId: "id-1",
      time: 42,
    });
  });

  it("a stopped callback subscription receives nothing published afterwards", async () => {
    const second = Promise.withResolvers<number>();
    const stoppedSaw: number[] = [];
    const liveSaw: number[] = [];
    await runTestPromise(
      Effect.gen(function* () {
        const sink = yield* ObservationSink;
        const first = Promise.withResolvers<void>();
        const stop = sink.subscribe(TestEvent, (data) => {
          stoppedSaw.push(data.value);
          first.resolve();
        });
        const stopLive = sink.subscribe(TestEvent, (data) => {
          liveSaw.push(data.value);
          if (data.value === 2) second.resolve(data.value);
        });
        sink.publish(TestEvent, { sessionId: "session-1", value: 1 });
        yield* Effect.promise(() => bounded(first.promise, "first delivery"));
        // stop() interrupts the drain fiber before the next publish, so value 2
        // is never enqueued for the stopped subscription — no timing involved.
        stop();
        sink.publish(TestEvent, { sessionId: "session-1", value: 2 });
        yield* Effect.promise(() => bounded(second.promise, "live subscriber second delivery"));
        stopLive();
      }).pipe(Effect.provide(observationBusLayer({ id: () => "layer-event", now: () => 7 }))),
    );
    expect(stoppedSaw).toEqual([1]);
    expect(liveSaw).toEqual([1, 2]);
  });
});
