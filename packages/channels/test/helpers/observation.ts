import type { BusEvent } from "@oni/protocol";
import { Effect, FiberSet, PubSub, Scope, Stream } from "effect";
import { runEffect } from "./effect";

type Datum = object | string | number | boolean | bigint | symbol | null | undefined;
type Watcher = (event: { readonly name: string }, data: Datum) => void;
interface Published {
  readonly name: string;
  readonly data: Datum;
}

/** Fixture plumbing outlives any one test; this process-lifetime Scope owns it. */
const fixture = runEffect(
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const pubsub = yield* PubSub.unbounded<Published>();
    const taps = yield* FiberSet.make<void, never>().pipe(Scope.provide(scope));
    const fork = yield* FiberSet.runtime(taps)<never>().pipe(Scope.provide(scope));
    return { pubsub, taps, fork };
  }),
  "sync",
);

/**
 * The channels-suite observation fixture (#1249): a PubSub-backed publish
 * port with Stream-drained watchers. `reset()` interrupts every watcher so
 * scenarios isolate without any ambient storage.
 */
export const Bus = {
  publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
    PubSub.publishUnsafe(fixture.pubsub, { name: event.name, data: data as Datum });
  },
  observe(watcher: Watcher): () => void {
    const fiber = fixture.fork(
      Effect.scoped(Effect.flatMap(PubSub.subscribe(fixture.pubsub), (subscription) =>
        Stream.runForEach(Stream.fromSubscription(subscription), (published) =>
          Effect.sync(() => watcher({ name: published.name }, published.data))))),
    );
    return () => fiber.interruptUnsafe();
  },
  reset(): void {
    for (const fiber of fixture.taps) fiber.interruptUnsafe();
  },
};
