import { Machine, type ObservationSink } from "@oni/protocol";
import type { ComputerPolicy } from "./computer-policy";

export function computerEvents(
  policy: ComputerPolicy,
  sink: ObservationSink & Required<Pick<ObservationSink, "subscribe">>,
): ObservationSink & Required<Pick<ObservationSink, "subscribe">> {
  return {
    subscribe: sink.subscribe,
    publish(event, data) {
      switch (event.name) {
        case Machine.Events.HumanInput.name:
          policy.pause(Machine.Events.HumanInput.schema.parse(data).machineId, "human_input");
          break;
        case Machine.Events.Private.name: {
          const fact = Machine.Events.Private.schema.parse(data);
          if (fact.state === "entered") policy.pause(fact.machineId, "private");
          break;
        }
        case Machine.Events.Attached.name:
          policy.attached(Machine.Events.Attached.schema.parse(data).machineId);
          break;
        case Machine.Events.Detached.name:
          policy.transportLost(Machine.Events.Detached.schema.parse(data).machineId);
          break;
      }
      sink.publish(event, data);
    },
  };
}
