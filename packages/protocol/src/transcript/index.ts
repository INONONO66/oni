import * as Fold from "./fold.js";
import * as Schema from "./schema.js";

/**
 * Transcript domain: append-only conversation-history facts and the pure fold
 * projecting them into Message.WithParts. Consumed by `packages/ai/src/processor`;
 * the domain carries no bus event descriptors.
 */
export namespace Transcript {
  export const Usage = Schema.Usage;
  export type Usage = Schema.Usage;

  export const PartTransition = Schema.PartTransition;
  export type PartTransition = Schema.PartTransition;

  export const FinishReason = Schema.FinishReason;
  export type FinishReason = Schema.FinishReason;

  export const Fact = Schema.Fact;
  export type Fact = Schema.Fact;

  export const fold = Fold.fold;
}
