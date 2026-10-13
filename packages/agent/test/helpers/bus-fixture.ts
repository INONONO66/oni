/**
 * #1348: per-test fixture for the `makeObservationBus` interest suites
 * (#1305/#1314). Each acquisition mints a fresh `published` collector and its
 * own deterministic id/clock sources, and acquires the bus in the caller's
 * Scope, so consecutive tests share no PubSub and no collector.
 */
import { Effect, type Scope } from "effect";
import { makeObservationBus, type ObservationBus } from "../../src/core/observation/bus";

export interface PublishRecord {
  readonly name: string;
  readonly delivered: boolean;
}

export interface InterestBus {
  readonly bus: ObservationBus;
  /** Every `onPublish(eventName, delivered)` decision, in publish order. */
  readonly published: PublishRecord[];
}

/** Deterministic id/clock sources that record each publish decision into `published`. */
export function recordingSources(published: PublishRecord[]) {
  let n = 0;
  return {
    id: () => `event-${++n}`,
    now: () => ++n,
    onPublish: (eventName: string, delivered: boolean) => {
      published.push({ name: eventName, delivered });
    },
  };
}

/** A fresh bus over fresh recording sources, released with the caller's Scope. */
export function interestBus(): Effect.Effect<InterestBus, never, Scope.Scope> {
  const published: PublishRecord[] = [];
  return makeObservationBus(recordingSources(published)).pipe(Effect.map((bus) => ({ bus, published })));
}

/**
 * Publish `publish()` until the bus reports a delivered publish: callback
 * subscribers fork their drain, so interest is awaited as the exact
 * `delivered: true` decision rather than a timing guess.
 */
export function publishUntilDelivered(
  fixture: InterestBus,
  publish: () => void,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (;;) {
      publish();
      if (fixture.published.at(-1)?.delivered === true) return;
      yield* Effect.yieldNow;
    }
  });
}

/** Yield until `check()` holds — a state predicate, never an elapsed duration. */
export function yieldUntil(check: () => boolean): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (;;) {
      if (check()) return;
      yield* Effect.yieldNow;
    }
  });
}
