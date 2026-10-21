import { type BusEvent, type PlainValue, PlainValueSchema } from "@oni/protocol";

/** Event-name buckets erase T; publish restores it after validating that event. */
type Subscriber = (data: never) => void;
const subscriptions = new Map<string, Set<Subscriber>>();
let delivery = Promise.resolve();
let generation = 0;

function publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
  const parsed = event.schema.parse(data);
  const listeners = [...(subscriptions.get(event.name) ?? [])];
  const epoch = generation;
  delivery = delivery.then(() => {
    if (epoch !== generation) return;
    for (const subscriber of listeners) subscriber(parsed as never);
  });
}

function subscribe<T>(
  event: BusEvent.Descriptor<T>,
  handler: (data: T) => void,
  options?: { match?: Partial<T> },
): () => void {
  const expected = options?.match === undefined ? undefined : PlainValueSchema.parse(options.match);
  const set = subscriptions.get(event.name) ?? new Set<Subscriber>();
  const subscriber: Subscriber = (data) => {
    if (expected !== undefined && !matches(data, expected)) return;
    handler(data);
  };
  set.add(subscriber);
  subscriptions.set(event.name, set);
  return () => {
    set.delete(subscriber);
    if (set.size === 0 && subscriptions.get(event.name) === set) subscriptions.delete(event.name);
  };
}

function matches<T>(data: T, expected: PlainValue): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) return false;
  return Object.entries(expected).every(([key, value]) => Reflect.get(data, key) === value);
}

export const Bus = {
  publish,
  subscribe,
  flush: () => delivery,
  listenerCount: () => [...subscriptions.values()].reduce((count, set) => count + set.size, 0),
  reset(): void {
    generation += 1;
    subscriptions.clear();
    delivery = Promise.resolve();
  },
};
