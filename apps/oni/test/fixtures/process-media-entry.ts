import { appendFileSync } from "node:fs";
import { Operational } from "@oni/protocol";
import { gatewayRuntime } from "../../src/gateway";
import { runProcessEntry } from "../../src/process-entry";
import { Bus } from "../helpers/bus";

await runProcessEntry({
  stdin: process.stdin,
  log: console.log,
  exit: process.exit,
  gatewayRuntime: (options) => gatewayRuntime({
    ...options,
    observations: {
      ...Bus,
      publish(event, data) {
        Bus.publish(event, data);
        if (event.name === Operational.Events.Warn.name) {
          appendFileSync(`${options.catalogPath}.warnings`, `${JSON.stringify(Operational.Events.Warn.schema.parse(data))}\n`);
        }
      },
    },
  }),
});
Bus.reset();
