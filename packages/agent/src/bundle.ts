/**
 * `Bundle` namespace assembly: the core bundle/compose surface plus the
 * removable `plugins/alarm` capability the app composes. Root assembly files
 * are the one legal meeting point of core and plugin bands; neither side
 * imports the other directly.
 */
export * from "./core/composition/compose";
export * from "./plugins/action";
export * from "./plugins/alarm";
export * from "./plugins/hook";
// Dispatcher construction lives in plugins/tool; this barrel is the one legal
// meeting point that hands it to the app and the core loop.
export * from "./plugins/tool";

// The three declaration contracts, surfaced for the app manifest.
// `Bundle.define` is the barrel's `define`.
export {
  Capability, defineBundle as define, Manifest, DefineRefused, CapabilityHookError, seam,
  type BundleContract, type BundleContractInput, type BundleGateRow, type BundleTool,
  type CapabilityCore, type CapabilityDefinition, type CapabilityInput,
  type CapabilityInputRow, type CapabilityKindDeclaration, type CapabilityStep,
  type ManifestDefinition, type ManifestInput, type SeamTag,
} from "./core/ports/capability";
export { AlarmSeam } from "./core/ports/alarm";

// The compaction capability needs the inspect band's fold/hydrate — an import
// the plugin band may not make — so this root assembly file wires the history
// ports into the published definition the app lists in its manifest.
export { CompactionSeam } from "./core/ports/compaction-ports";
export type { CompactionOptions, CompactionSeamService } from "./core/ports/compaction-ports";

import { foldSessionHistory, hydrateSessionHistory } from "./inspect/history";
import {
  compactionCapability as defineCompactionCapability,
  type CompactionHistoryPorts,
} from "./plugins/compaction";
const compactionHistoryPorts: CompactionHistoryPorts = {
  fold: foldSessionHistory,
  hydrate: hydrateSessionHistory,
};

/** The compaction capability with its history ports wired. */
export function compactionCapability() {
  return defineCompactionCapability(compactionHistoryPorts);
}
