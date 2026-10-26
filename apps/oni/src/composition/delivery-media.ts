import type { LlmService, PartBytes, PartDerive } from "@oni/llm";
import { Effect } from "effect";

/**
 * The ledger carries media refs in delivery content and replayed messages.
 * This late-binding seam supplies their byte source when the model runs.
 */
export interface DeliveryMedia {
  /** Machines and the inbox resolve after the runtime builds the Llm layer, so the byte source binds late. */
  bind(bytes: PartBytes<Error>, derive?: PartDerive): void;
  bytes(): PartBytes<Error> | undefined;
  derive(): PartDerive | undefined;
}

export function deliveryMedia(): DeliveryMedia {
  let bound: PartBytes<Error> | undefined;
  let derivation: PartDerive | undefined;
  return {
    bind(bytes, derive) {
      bound = bytes;
      derivation = derive;
    },
    bytes: () => bound,
    derive: () => derivation,
  };
}

export function mediaLlm(
  service: LlmService,
  media: DeliveryMedia,
): LlmService {
  const run: LlmService["run"] = (input, sink, dependencies) => Effect.suspend(() => {
    const bytes = media.bytes();
    if (bytes === undefined) return service.run(input, sink, dependencies);
    const derive = media.derive();
    return service.run({ ...input, media: { bytes, ...(derive === undefined ? {} : { derive }) } }, sink, dependencies);
  });
  return { ...service, run };
}
