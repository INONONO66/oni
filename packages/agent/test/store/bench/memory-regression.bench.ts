/**
 * The memory guard runs on the production observation bus
 * (`makeObservationBus`, an Effect PubSub in a Scope), not a test substitute.
 * Subscriptions are acquired and released deterministically through Effect
 * Scopes, and leak-freedom is asserted on the bus's own `subscriberCount()`.
 */
import { sessionTree } from "../helpers/session-tree";
import { describe, expect, test } from "bun:test";
import { L0Observation } from "@openomni/protocol";
import { Effect, Stream } from "effect";
import { makeObservationBus } from "../../../src/core/observation/bus";
import { yieldUntil } from "../../helpers/bus-fixture";
import { runTestPromise } from "../../helpers/isolated";
import { materializeSession } from "../helpers/session";
import { useMemoryStores } from "../helpers/storage";

const stores = useMemoryStores();

function busOptions() {
  let n = 0;
  return { id: () => `memory-guard-${++n}`, now: () => ++n };
}

describe("session memory regression", () => {
  test("canonical watch subscribe/unsubscribe releases listeners without deleting history", async () => {
    await runTestPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bus = yield* makeObservationBus(busOptions());
          const settled = (count: number) =>
            // Await the exact subscription state, never a timer: the callback
            // drain registers and releases on its own fiber.
            yieldUntil(() => bus.subscriberCount() === count, `${count} subscribers`);
          materializeSession(stores.kernel, "watched");
          const baseline = bus.subscriberCount();
          for (let index = 0; index < 200; index += 1) {
            const watch = stores.kernel.watchSnapshot("watched", 1, bus.sink);
            watch.subscribe(() => undefined);
            yield* settled(baseline + 1);
            watch.unsubscribe();
            yield* settled(baseline);
          }
          expect(bus.subscriberCount()).toBe(baseline);
        }),
      ),
    );
    expect(sessionTree("watched", stores.session.actions)).toHaveLength(1);
  }, 30_000);

  test("bus subscribe/publish/unsubscribe does not leak", async () => {
    await runTestPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bus = yield* makeObservationBus(busOptions());
          const baseline = bus.subscriberCount();
          let received = 0;
          for (let index = 0; index < 500; index += 1) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const deliveries = yield* bus.stream(L0Observation.ActionCommittedEvent);
                for (let eventIndex = 0; eventIndex < 10; eventIndex += 1) {
                  bus.sink.publish(L0Observation.ActionCommittedEvent, {
                    id: `${index}-${eventIndex}`,
                    sessionId: "fanout",
                    revision: 1,
                    kind: "session.configure",
                  });
                }
                yield* Stream.runForEach(Stream.take(deliveries, 10), () =>
                  Effect.sync(() => {
                    received += 1;
                  }),
                );
              }),
            );
          }
          expect(received).toBe(5000);
          expect(bus.subscriberCount()).toBe(baseline);
        }),
      ),
    );
  }, 30_000);

  test("idempotent canonical materialization does not accumulate rows or history", () => {
    const hydrate = () => {
      materializeSession(stores.kernel, "existing");
      stores.kernel.getSnapshot("existing");
    };
    for (let index = 0; index < 500; index += 1) hydrate();
    expect(stores.kernel.listRows()).toHaveLength(1);
    expect(sessionTree("existing", stores.session.actions)).toHaveLength(1);
  }, 30_000);
});
