import { Effect } from "effect";
import { MachineRefusalError, type MachineError } from "@oni/machines";

/** #1312: the explicit tool port for test hosts wired without a real one. */
export function refusingToolPort(): Effect.Effect<never, MachineError> {
  return Effect.fail(new MachineRefusalError({ reason: "host_tool_missing", message: "host_tool_missing: this host was wired without a tool port" }));
}
