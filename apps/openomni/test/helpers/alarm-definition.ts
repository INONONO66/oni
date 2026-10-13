import { Bundle } from "@openomni/agent";
import { Effect } from "effect";
import { runEffect } from "./effect";

/** Minimal composed alarm capability for bundle manifest tests. */
export async function alarmDefinition(): Promise<Bundle.CapabilityDefinition<"alarm">> {
  const capability = await runEffect(Bundle.alarmCapability({
    bundles: [],
    arm: () => () => Effect.die(new Error("unused arm")),
    watch: { install: () => Effect.void },
  }));
  return capability.definition;
}
