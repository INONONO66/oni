import type { Core } from "@openomni/agent";
type CompactionOptions = Core.CompactionOptions;
type ObservationSink = Core.ObservationSink;
type Llm = Core.Llm;
import { Effect } from "effect";
import type { OpenOmniConfig } from "../../config";
import { modelTransport } from "../../config";
import { createCompactionSummarizer } from "./summarizer";

/** Translate operator configuration into the callback-free run-scoped strategy. */
export function configuredCompaction(
  config: OpenOmniConfig,
  sources: { readonly now: () => number; readonly id: () => string },
): Effect.Effect<CompactionOptions, never, Llm | ObservationSink> {
  return Effect.gen(function* () {
  const transport = modelTransport(config.model);
  return {
    elideToolOutputs: { minOutputChars: 4000, keepHeadChars: 500 },
    ...(config.compactionSummarizer === false
      ? {}
      : {
          onSummarize: yield* createCompactionSummarizer({
            now: sources.now,
            id: sources.id,
            model: { ...config.model, ...(transport === undefined ? {} : { transport }) },
          }),
        }),
  };
  });
}
