import { Bundle } from "@openomni/agent";

/** Shared product defaults used by delegation guards and gateway admission. */
export const DEFAULT_DELEGATION_CAPS = Object.freeze({ maxDepth: 3, maxActiveChildren: 4 });

/**
 * App-owned capability ports (#1255/#1258), declared outside `manifest.ts` so
 * bundles can require them without importing the manifest that lists the
 * bundles (no cycle). The manifest's `Capability.define` contracts carry
 * these exact tags. The action capability's port moved to the plugin with
 * #1304: bundles require `Bundle.ActionPort` from `@openomni/agent`.
 */

/** Persisted manifest hash preimages require this key to remain byte-identical. */
export const ToolCapabilityPort = Bundle.port("@openomni/openomni/ToolCapabilitySeam");

/** Persisted manifest hash preimages require this key to remain byte-identical. */
export const CompactionSummarizerPort = Bundle.port("@openomni/openomni/CompactionSummarizerSeam");
