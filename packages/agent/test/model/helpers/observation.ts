import type { BusEvent } from "@openomni/protocol";

type Datum = object | string | number | boolean | bigint | symbol | null | undefined;
type Listener = (descriptor: BusEvent.Descriptor<never>, value: never) => void;
const listeners = new Map<string, Set<Listener>>();

function publish<T>(descriptor: BusEvent.Descriptor<T>, value: T): void {
  for (const listener of listeners.get(descriptor.name) ?? []) {
    queueMicrotask(() => listener(descriptor as BusEvent.Descriptor<never>, value as never));
  }
}

function subscribe<T>(
  descriptor: BusEvent.Descriptor<T>,
  listener: (value: T) => void,
): () => void {
  const bucket = listeners.get(descriptor.name) ?? new Set<Listener>();
  const wrapped: Listener = (_event, value) => listener(value);
  bucket.add(wrapped);
  listeners.set(descriptor.name, bucket);
  return () => bucket.delete(wrapped);
}

export const Bus = {
  publish,
  subscribe,
  reset: () => listeners.clear(),
};

export interface Collector extends BusEvent.Sink {
  readonly events: readonly { readonly name: string; readonly data: Datum }[];
  named(name: string): readonly Datum[];
  reset(): void;
}

export function collector(): Collector {
  const events: Array<{ readonly name: string; readonly data: Datum }> = [];
  return {
    events,
    publish: (event, data) => events.push({ name: event.name, data: data as Datum }),
    named: (name) => events.filter((entry) => entry.name === name).map((entry) => entry.data),
    reset: () => {
      events.length = 0;
    },
  };
}

let traceCounter = 0;
export function newTraceId(): string {
  // Deterministic unique trace ids: tests must not read ambient entropy.
  traceCounter += 1;
  return `trace${traceCounter.toString(16).padStart(27, "0")}`;
}
