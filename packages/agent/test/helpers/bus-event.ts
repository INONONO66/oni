import type { BusEvent } from "@oni/protocol";
import { Bus } from "./bus";
import { bounded } from "./bounded";

const EVENT_TIMEOUT_MS = 1_000;

/** Resolve after the expected events arrive; stay subscribed so callers can assert exact counts. */
export function captureBusEvents<T>(
  event: BusEvent.Descriptor<T>,
  count = 1,
  onEvent?: (event: T) => void,
): { readonly events: T[]; readonly done: Promise<readonly T[]>; unsubscribe: () => void } {
  const events: T[] = [];
  const arrived = Promise.withResolvers<readonly T[]>();
  const settle = arrived.resolve;
  const unsubscribe = Bus.subscribe(event, (payload) => {
    events.push(payload);
    onEvent?.(payload);
    if (events.length === count) settle(events);
  });
  const done = bounded(arrived.promise, `${count} ${event.name} event(s)`, EVENT_TIMEOUT_MS);

  return {
    events,
    done,
    // Releasing the capture also releases the deadline: nothing awaits `done` afterwards.
    unsubscribe: () => {
      unsubscribe();
      settle(events);
    },
  };
}
