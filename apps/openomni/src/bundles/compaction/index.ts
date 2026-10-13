import { Bundle, type Core } from "@openomni/agent";
import { Effect } from "effect";
import type { OpenOmniConfig } from "../../config";
import { modelTransport } from "../../config";
import { createCompactionSummarizer } from "./summarizer";
import { CompactionSummarizerSeam } from "../seams";

/**
 * The app's summarizer provider: the model-backed adapter, or — with
 * `OPENOMNI_COMPACTION_SUMMARIZER=off` — the operator's explicit cut-only choice.
 */
export function compactionSummarizerBundle(): Bundle.BundleContract<"compaction-summarizer"> {
  return Bundle.define({
    name: "compaction-summarizer",
    requires: [],
    provides: [CompactionSummarizerSeam],
  });
}

/**
 * The binding that hands the compaction capability its run options. It requires a
 * summarizer provider, so a manifest that keeps compaction on without one refuses
 * `seam_missing` at compose: the plugin's cut-only fallback is never the default.
 */
export function compactionBundle(): Bundle.BundleContract<"compaction-strategy"> {
  return Bundle.define({
    name: "compaction-strategy",
    requires: [Bundle.CompactionSeam, CompactionSummarizerSeam],
  });
}

/** The run options the binding hands the plugin; elision and geometry defaults are the plugin's. */
export function compactionOptions(
  config: OpenOmniConfig,
  sources: {
    readonly now: () => number;
    readonly id: () => string;
    readonly sessionId: string;
    readonly system: string;
  },
): Effect.Effect<Core.CompactionOptions, never, Core.Llm | Core.ObservationSink> {
  return Effect.gen(function* () {
    if (config.compactionSummarizer === false) return {};
    const transport = modelTransport(config.model);
    return {
      onSummarize: yield* createCompactionSummarizer({
        ...sources,
        model: { ...config.model, ...(transport === undefined ? {} : { transport }) },
      }),
    };
  });
}
