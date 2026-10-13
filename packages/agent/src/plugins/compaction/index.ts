import {
  Capability,
  CompactionSeam,
  type CapabilityDefinition,
  type CompactionSeamService,
  type SeamTag,
} from "../../core/api";
import { bindCompactionRun } from "./policy";
import { prepareCompactionRestore } from "./restore";
import { createCompactionPin, type CompactionHistoryPorts } from "./successor";

export { Compaction } from "./compact";
export { DEFAULT_TOOL_OUTPUT_ELISION } from "./contract";
export { CompactionSession } from "./speculate";
export type { CompactionHistoryPorts } from "./successor";

/** The two run-free operations plus the binding that yields a run's `maybeCompact`/`window`. */
export function compactionSeamService(history: CompactionHistoryPorts): CompactionSeamService {
  const ports = { pinAction: createCompactionPin(history), prepareRestore: prepareCompactionRestore };
  return Object.freeze({
    ...ports,
    bind: (binding) => bindCompactionRun(binding, ports),
  } satisfies CompactionSeamService);
}

/**
 * The removable compaction capability: no new kind, point, input or model tool — exactly the seam
 * service commit, restore and the run loop consume. Off = those paths skip and record nothing.
 */
export function compactionCapability(
  history: CompactionHistoryPorts,
): CapabilityDefinition<"compaction", SeamTag, CompactionSeamService> {
  return Capability.define({
    name: "compaction",
    requires: [],
    verbs: compactionSeamService(history),
    seam: CompactionSeam,
  });
}
