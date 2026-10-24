import { Gateway, parseJson, PlainValueSchema } from "@oni/protocol";
import { z } from "zod";

const PartsFrame = z.object({
  eventId: z.string().min(1),
  parts: z.array(Gateway.MediaPart).min(1),
});

export type WsPartsRefusal = { readonly type: "error"; readonly reason: "invalid_parts"; readonly detail: string };

/**
 * The perimeter's ws text frame keeps only its own keys, so `parts` is read
 * here from the same raw frame and handed to the ingest step by
 * (connection, eventId). A frame whose `parts` do not parse is refused whole
 * rather than admitted as text that silently lost its media.
 */
export function wsParts() {
  const pending = new Map<string, readonly Gateway.MediaPart[]>();
  const key = (externalId: string, eventId: string) => JSON.stringify([externalId, eventId]);
  return {
    capture(externalId: string, data: string | Buffer): { readonly release: () => void } | WsPartsRefusal | undefined {
      const document = parseJson(PlainValueSchema, typeof data === "string" ? data : data.toString());
      if (document === null || typeof document !== "object" || Array.isArray(document) || !("parts" in document))
        return undefined;
      const frame = PartsFrame.safeParse(document);
      if (!frame.success) return { type: "error", reason: "invalid_parts", detail: z.prettifyError(frame.error) };
      const id = key(externalId, frame.data.eventId);
      pending.set(id, frame.data.parts);
      return { release: () => pending.delete(id) };
    },
    take(externalId: string, eventId: string): readonly Gateway.MediaPart[] | undefined {
      const id = key(externalId, eventId);
      const parts = pending.get(id);
      pending.delete(id);
      return parts;
    },
  };
}

export type WsParts = ReturnType<typeof wsParts>;
