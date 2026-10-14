import { Bundle } from "@openomni/agent";

/**
 * App-owned capability seams (#1255/#1258), declared outside `manifest.ts` so
 * bundles can require them without importing the manifest that lists the
 * bundles (no cycle). The manifest's `Capability.define` contracts carry
 * these exact tags. The action capability's seam moved to the plugin with
 * #1304: bundles require `Bundle.ActionPort` from `@openomni/agent`.
 */

/** The tool capability's seam; `bundles/send-message` requires it. */
export const ToolCapabilitySeam = Bundle.port("@openomni/openomni/ToolCapabilitySeam");

/** The compaction summarizer provider's seam; `bundles/compaction` requires it next to the capability's. */
export const CompactionSummarizerSeam = Bundle.port("@openomni/openomni/CompactionSummarizerSeam");
