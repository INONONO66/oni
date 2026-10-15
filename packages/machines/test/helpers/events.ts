import { type BusEvent, Machine } from "@openomni/protocol";

type MachineEventPayload =
  | ReturnType<typeof Machine.Events.Attached.schema.parse>
  | ReturnType<typeof Machine.Events.Detached.schema.parse>
  | ReturnType<typeof Machine.Events.Reported.schema.parse>
  | ReturnType<typeof Machine.Events.PtyOutput.schema.parse>;
type EnrollmentEventPayload =
  | ReturnType<typeof Machine.Events.Enrolled.schema.parse>
  | ReturnType<typeof Machine.Events.Unenrolled.schema.parse>;
export type RecordedEvent = {
  readonly name: string;
  readonly payload: MachineEventPayload | EnrollmentEventPayload;
};

function parseEvent<T>(name: string, payload: T): RecordedEvent {
  if (name === Machine.Events.Enrolled.name) return { name, payload: Machine.Events.Enrolled.schema.parse(payload) };
  if (name === Machine.Events.Unenrolled.name) return { name, payload: Machine.Events.Unenrolled.schema.parse(payload) };
  if (name === Machine.Events.Attached.name) return { name, payload: Machine.Events.Attached.schema.parse(payload) };
  if (name === Machine.Events.Reported.name) return { name, payload: Machine.Events.Reported.schema.parse(payload) };
  if (name === Machine.Events.PtyOutput.name) return { name, payload: Machine.Events.PtyOutput.schema.parse(payload) };
  return { name, payload: Machine.Events.Detached.schema.parse(payload) };
}

/** Records host attach/detach/report events; `next` resolves on the NEXT named event. */
export function eventCollector() {
  const events: RecordedEvent[] = [];
  const waiters: Array<{ name: string; resolve: (event: RecordedEvent) => void }> = [];
  const sink: BusEvent.Sink = {
    publish(descriptor, payload) {
      const event = parseEvent(descriptor.name, payload);
      events.push(event);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i];
        if (waiter && waiter.name === event.name) {
          waiters.splice(i, 1);
          waiter.resolve(event);
        }
      }
    },
  };
  return {
    sink,
    events,
    /** Resolves on the NEXT event of this name (bounded by bun's test timeout). */
    next(name: string): Promise<RecordedEvent> {
      return new Promise((resolve) => {
        waiters.push({ name, resolve });
      });
    },
  };
}
