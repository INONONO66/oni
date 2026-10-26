import type { LlmService, PartBytes, PartDerive } from "@oni/llm";
import type { Delivery, Gateway } from "@oni/protocol";
import { Effect } from "effect";

/**
 * Media a delivery commit carried, held in process memory until the turn that
 * drains it calls the model. The ledger records media refs in content; this
 * sidecar supplies the byte source until model input consumes those refs.
 */
export interface DeliveryMedia {
  remember(deliveryId: string, parts: readonly Gateway.MediaPart[] | undefined): void;
  recall(deliveryId: string): readonly Gateway.MediaPart[] | undefined;
  /** Machines and the inbox resolve after the runtime builds the Llm layer, so the byte source binds late. */
  bind(bytes: PartBytes<Error>, derive?: PartDerive): void;
  bytes(): PartBytes<Error> | undefined;
  derive(): PartDerive | undefined;
}

const DELIVERY_MEDIA_CAP = 256;

export function deliveryMediaParts(content: Delivery.Content): readonly Gateway.MediaPart[] {
  return content.filter((part): part is Gateway.MediaPart => part.kind !== "text");
}

export function deliveryMedia(cap = DELIVERY_MEDIA_CAP): DeliveryMedia {
  const held = new Map<string, readonly Gateway.MediaPart[]>();
  let bound: PartBytes<Error> | undefined;
  let derivation: PartDerive | undefined;
  return {
    remember(deliveryId, parts) {
      if (parts === undefined || parts.length === 0) return;
      held.delete(deliveryId);
      held.set(deliveryId, parts);
      for (const oldest of held.keys()) {
        if (held.size <= cap) break;
        held.delete(oldest);
      }
    },
    recall: (deliveryId) => held.get(deliveryId),
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
    const parts = input.messages.flatMap((message) => {
      if (message.info.role !== "user") return [];
      const parts = media.recall(message.info.id);
      return parts === undefined ? [] : [{ messageId: message.info.id, parts }];
    });
    const derive = media.derive();
    const bound = { parts, bytes, ...(derive === undefined ? {} : { derive }) };
    return service.run(parts.length === 0 ? input : { ...input, media: bound }, sink, dependencies);
  });
  return { ...service, run };
}
