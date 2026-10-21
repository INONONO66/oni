import { BusEvent, type ObservationSink, Gateway, type Delivery, type SessionTurn } from "@oni/protocol";
import { Data, Effect, FiberSet, Layer, PubSub, type Scope, Stream } from "effect";
import { z } from "zod";
import { ObservationSink as ObservationSinkTag } from "../ports/ports";

const DeliveryFailure = z.object({
  eventName: z.string(),
  error: z.string(),
  reporterError: z.string().optional(),
});
type DeliveryFailure = z.infer<typeof DeliveryFailure>;

/** Reported as data on the plane it failed on, never thrown or logged; a failing report drops. */
export const ObservationDeliveryFailed = BusEvent.define(
  "observation.delivery_failed",
  DeliveryFailure,
  { visibility: "internal" },
);

type FailureReporter = (error: Error, eventName: string) => void;

type ObservationData = bigint | boolean | null | number | object | string | symbol | undefined;

export interface PublishedObservation {
  readonly name: string;
  readonly visibility?: BusEvent.Visibility;
  readonly data: ObservationData;
}

function describeFailure(value: ObservationData): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function asError(value: ObservationData): Error {
  return value instanceof Error ? value : new Error(describeFailure(value));
}

type SinkService = ObservationSink & Required<Pick<ObservationSink, "subscribe" | "scope">>;

export interface ObservationBus {
  readonly sink: SinkService;
  /** `PubSub.subscribe` installs the finalizer in the caller's Scope. */
  readonly observations: Effect.Effect<Stream.Stream<PublishedObservation>, never, Scope.Scope>;
  readonly stream: <T>(
    event: BusEvent.Descriptor<T>,
    options?: { readonly match?: Partial<T> },
  ) => Effect.Effect<Stream.Stream<T>, never, Scope.Scope>;
  /** Purely observational — never consulted by `publish`. */
  readonly subscriberCount: () => number;
}

export interface ObservationBusOptions {
  /** Never ambient. */
  readonly id: () => string;
  /** Never ambient. */
  readonly now: () => number;
  readonly onError?: FailureReporter;
  /** Called once per `publish` with the enqueued flag, so skips count without subscribing. */
  readonly onPublish?: (eventName: string, delivered: boolean) => void;
}

/** Logged on the subscriber's own fiber, never the publisher's. */
export class ObservationSubscriberFailure extends Data.TaggedError("ObservationSubscriberFailure")<{
  readonly eventName: string;
  readonly cause: string;
}> {}

/**
 * Publication is synchronous, nonblocking and lossy — observations are never journal-durable;
 * closing a subscriber's Scope interrupts its drain.
 */
export const makeObservationBus = (
  options: ObservationBusOptions,
): Effect.Effect<ObservationBus, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<PublishedObservation>(),
      PubSub.shutdown,
    );
    const forkDrain = yield* FiberSet.makeRuntime<never, void, never>();
    // Per-event-name interest, exact: acquired on subscribe, released by the
    // finalizer. `match` predicates are deliberately NOT consulted at publish
    // time; the stream filters on the consumer side, so publish never pays for them.
    let allEventsInterest = 0;
    const namedInterest = new Map<string, number>();
    // One exact live-subscription count for the memory guard; read-only outside.
    let liveSubscriptions = 0;
    const subscription = (register: () => void, deregister: () => void) =>
      Effect.map(
        Effect.acquireRelease(
          Effect.tap(PubSub.subscribe(pubsub), () =>
            Effect.sync(() => {
              liveSubscriptions += 1;
              register();
            }),
          ),
          () =>
            Effect.sync(() => {
              liveSubscriptions -= 1;
              deregister();
            }),
        ),
        Stream.fromSubscription,
      );
    const observations = subscription(
      () => {
        allEventsInterest += 1;
      },
      () => {
        allEventsInterest -= 1;
      },
    );
    const stream = <T>(
      event: BusEvent.Descriptor<T>,
      streamOptions?: { readonly match?: Partial<T> },
    ) =>
      Effect.map(
        subscription(
          () => {
            namedInterest.set(event.name, (namedInterest.get(event.name) ?? 0) + 1);
          },
          () => {
            const remaining = (namedInterest.get(event.name) ?? 0) - 1;
            if (remaining <= 0) namedInterest.delete(event.name);
            else namedInterest.set(event.name, remaining);
          },
        ),
        (all) =>
          all.pipe(
            Stream.filter((published) => published.name === event.name),
            Stream.map((published) => published.data as T),
            Stream.filter(
              (data) => streamOptions?.match === undefined || matches(data, streamOptions.match),
            ),
          ),
      );
    const sink: SinkService = {
      publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
        // No matching subscriber, no publication: a large payload is never
        // serialized onto a plane nobody drains. The lossy contract is unchanged.
        const delivered = allEventsInterest > 0 || namedInterest.has(event.name);
        options.onPublish?.(event.name, delivered);
        if (!delivered) return;
        PubSub.publishUnsafe(pubsub, {
          name: event.name,
          ...(event.visibility === undefined ? {} : { visibility: event.visibility }),
          data: data as ObservationData,
        });
      },
      subscribe<T>(
        event: BusEvent.Descriptor<T>,
        handler: (data: T) => void,
        subscribeOptions?: { match?: Partial<T> },
      ): () => void {
        const fiber = forkDrain(
          Effect.scoped(
            Effect.flatMap(
              stream(event, subscribeOptions),
              Stream.runForEach((data) =>
                Effect.suspend(() => {
                  try {
                    handler(data);
                    return Effect.void;
                  } catch (cause) {
                    return Effect.logError(
                      new ObservationSubscriberFailure({
                        eventName: event.name,
                        cause: describeFailure(cause as ObservationData),
                      }),
                    );
                  }
                }),
              ),
            ),
          ),
        );
        return () => fiber.interruptUnsafe();
      },
      scope: (identity) => scopeObservation(sink, identity, options),
    };
    return { sink, observations, stream, subscriberCount: () => liveSubscriptions };
  });

export const observationBusLayer = (
  options: ObservationBusOptions,
): Layer.Layer<ObservationSinkTag> =>
  Layer.effect(ObservationSinkTag, Effect.map(makeObservationBus(options), (bus) => bus.sink));

function exposeFailure(sink: ObservationSink, failure: DeliveryFailure): void {
  if (failure.eventName === ObservationDeliveryFailed.name) return;
  try {
    sink.publish(ObservationDeliveryFailed, failure);
  } catch {
    // The plane itself is unavailable; there is nothing left to report to.
  }
}

/** If the injected reporter throws, both failures reach the plane. */
function reportObservationFailure(
  sink: ObservationSink,
  error: Error,
  eventName: string,
  report: FailureReporter | undefined,
): void {
  if (report === undefined) {
    exposeFailure(sink, { eventName, error: describeFailure(error) });
    return;
  }
  try {
    report(error, eventName);
  } catch (reporterError) {
    exposeFailure(sink, {
      eventName,
      error: describeFailure(error),
      reporterError: describeFailure(reporterError as ObservationData),
    });
  }
}

function matches<T>(data: T, match: Partial<T>): boolean {
  if (data === null || typeof data !== "object") return false;
  for (const key of Object.keys(match) as Array<keyof T>) {
    if (data[key] !== match[key]) return false;
  }
  return true;
}

interface ScopeObservationOptions {
  readonly now: () => number;
  readonly id: () => string;
  readonly onError?: FailureReporter;
}

export function scopeObservation(
  sink: ObservationSink,
  identity: Readonly<BusEvent.Metadata>,
  options: ScopeObservationOptions,
): ObservationSink {
  const { now, id } = options;

  const subscribe = sink.subscribe?.bind(sink);
  const scoped: ObservationSink = {
    publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
      try {
        if (data === null || typeof data !== "object" || Array.isArray(data)) {
          throw new TypeError("scoped observation payload must be an object");
        }
        const stamp = { eventId: id(), time: now(), ...identity };
        sink.publish(event, { ...data, ...stamp });
      } catch (error) {
        reportObservationFailure(sink, asError(error as ObservationData), event.name, options.onError);
      }
    },
    scope(childIdentity) {
      return scopeObservation(sink, { ...identity, ...childIdentity }, options);
    },
    ...(subscribe === undefined ? {} : { subscribe }),
  };
  return scoped;
}

/** Invoked only after the consuming transaction returns its receipt. */
export function observeDrained(
  rows: readonly Delivery.Row[],
  turnId: string,
  boundary: SessionTurn.Boundary,
  at: number,
  sink: ObservationSink,
  id: () => string,
): void {
  for (const row of rows) {
    const scoped = scopeObservation(
      sink,
      { sessionId: row.sessionId, turnId },
      { now: () => at, id },
    );
    scoped.publish(Gateway.MessageObserved, {
      kind: "message.drained",
      messageId: row.id,
      queueMs: Math.max(0, at - row.createdAt),
      boundary,
    });
  }
}
