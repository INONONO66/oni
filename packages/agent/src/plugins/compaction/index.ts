import {
  Capability,
  CompactionSeam,
  type CapabilityDefinition,
  type CompactionSeamService,
  type SeamTag,
} from "../../core/api";
import { Compaction } from "./compact";
import { DEFAULT_PROTECT_RECENT } from "./contract";
import { estimateMessagesTokens } from "./estimate";
import { executeCompaction } from "./execute-cut";
import { resolveCompactionGeometry } from "./geometry";
import { measuredContextTokens } from "./measure";
import { prepareCompactionRestore } from "./restore";
import { CompactionSession } from "./speculate";
import { createCompactionPin, type CompactionHistoryPorts } from "./successor";

export { Compaction } from "./compact";
export { CompactionSession } from "./speculate";
export type { CompactionHistoryPorts } from "./successor";

/** Every member IS the module export the kernel used to import: one frozen object. */
export function compactionSeamService(history: CompactionHistoryPorts): CompactionSeamService {
  return Object.freeze({
    protectRecent: DEFAULT_PROTECT_RECENT,
    geometry: resolveCompactionGeometry,
    measure: measuredContextTokens,
    estimate: estimateMessagesTokens,
    shouldCompact: Compaction.shouldCompact,
    execute: executeCompaction,
    createSession: (config) => new CompactionSession(config),
    pinAction: createCompactionPin(history),
    prepareRestore: prepareCompactionRestore,
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
