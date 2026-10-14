import { Bundle, type Core } from "@openomni/agent";
import { Duration, Effect } from "effect";
import type { OpenOmniConfig } from "../../config";
import { modelTransport } from "../../config";
import { createCompactionSummarizer, MAX_SUMMARY_OUTPUT_TOKENS, summaryDeadline } from "./summarizer";
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
    requires: [Bundle.CompactionPort, CompactionSummarizerSeam],
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
    readonly deadline?: Duration.Duration;
  },
): Effect.Effect<Core.CompactionOptions, never, Core.Llm | Core.ObservationSink> {
  return Effect.gen(function* () {
    if (config.compactionSummarizer === false) return {};
    const transport = modelTransport(config.model);
    const deadline = sources.deadline ?? summaryDeadline(MAX_SUMMARY_OUTPUT_TOKENS);
    return {
      onSummarize: yield* createCompactionSummarizer({
        ...sources,
        model: { ...config.model, ...(transport === undefined ? {} : { transport }) },
      }),
      // Core's speculative guard wraps the entire summary, including up to
      // three overflow windows with three executor calls each.
      summarizerDeadlineMs: Duration.toMillis(deadline) * 9 + 60_000,
    };
  });
}
