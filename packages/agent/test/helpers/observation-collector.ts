import type { ObservationSink } from "@oni/protocol";

type ObservationData = Parameters<ObservationSink["publish"]>[1];
export interface CollectingObservationSink extends ObservationSink {
  readonly events: readonly { readonly name: string; readonly data: ObservationData }[];
  named(name: string): readonly ObservationData[];
  reset(): void;
}

/** Records every published observation so a test can assert on scoped payloads. */
export function collector(): CollectingObservationSink {
  const events: { readonly name: string; readonly data: ObservationData }[] = [];
  return {
    publish(event, data) {
      events.push({ name: event.name, data });
    },
    events,
    named: (name) => events.filter((event) => event.name === name).map((event) => event.data),
    reset: () => {
      events.length = 0;
    },
  };
}
