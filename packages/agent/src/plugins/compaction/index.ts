import {
  Capability,
  CompactionPort,
  type CapabilityDefinition,
  type CompactionPortService,
  type PortTag,
} from "../../core/api";
import { bindCompactionRun } from "./policy";
import { prepareCompactionRestore } from "./restore";
import { createCompactionPin, type CompactionHistoryPorts } from "./successor";

export { Compaction } from "./compact";
export { CompactionSession } from "./speculate";
export type { CompactionHistoryPorts } from "./successor";

/** The two run-free operations plus the binding that yields a run's `maybeCompact`/`window`. */
export function compactionPortService(history: CompactionHistoryPorts): CompactionPortService {
  const ports = { pinAction: createCompactionPin(history), prepareRestore: prepareCompactionRestore };
  return Object.freeze({
    ...ports,
    bind: (binding) => bindCompactionRun(binding, ports),
  } satisfies CompactionPortService);
}

/**
 * The removable compaction capability: no new kind, point, input or model tool — exactly the
 * service commit, restore and the run loop consume. Off = those paths skip and record nothing.
 */
export function compactionCapability(
  history: CompactionHistoryPorts,
): CapabilityDefinition<"compaction", PortTag, CompactionPortService> {
  return Capability.define({
    name: "compaction",
    requires: [],
    verbs: compactionPortService(history),
    port: CompactionPort,
  });
}
