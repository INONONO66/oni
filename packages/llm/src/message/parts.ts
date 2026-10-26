import { Delivery, type Gateway, Operational } from "@oni/protocol";
import type { FilePart, ImagePart, TextPart } from "ai";
import { Effect, Result } from "effect";
import { Capability } from "../model/capability";
import type { RunInput } from "../run";

/** The app-provided byte source for a part `ref`; this package never reads storage or machines. */
export type PartBytes<E = Error> = (ref: string) => Effect.Effect<{ readonly bytes: Uint8Array; readonly mime: string }, E>;

export type UnacceptedPart<E> =
  | { readonly part: Gateway.MediaPart; readonly reason: "modality" }
  | { readonly part: Gateway.MediaPart; readonly reason: "unresolved"; readonly cause: E };

export type UserBlock = TextPart | ImagePart | FilePart;

/**
 * What the app derives for a part the effective model cannot read: prompt text (a transcript,
 * a frame-count line) and parts the model may read instead (sampled frames).
 */
export interface DerivedPart {
  readonly text?: string;
  readonly parts: readonly Gateway.MediaPart[];
}

/** App-owned, called per selected model; the app caches derivatives by originating `ref`. */
export type PartDerive = (part: Gateway.MediaPart, model: Capability.InputModel) => Effect.Effect<DerivedPart>;

function toBlock(part: Gateway.MediaPart, bytes: Uint8Array, sourceMime: string): UserBlock {
  const mime = part.mime ?? sourceMime;
  if (part.kind === "image") return { type: "image", image: bytes, mediaType: mime };
  return { type: "file", data: bytes, mediaType: mime, ...(part.name === undefined ? {} : { filename: part.name }) };
}

function resolvePart<E>(
  part: Gateway.MediaPart,
  model: Capability.InputModel,
  bytes: PartBytes<E>,
): Effect.Effect<UserBlock | UnacceptedPart<E>> {
  return Effect.gen(function* () {
    if (!Capability.accepts(model, part)) return { part, reason: "modality" as const };
    const resolved = yield* Effect.result(bytes(part.ref));
    if (Result.isFailure(resolved)) return { part, reason: "unresolved" as const, cause: resolved.failure };
    if (!Capability.accepts(model, { kind: part.kind, mime: part.mime ?? resolved.success.mime }))
      return { part, reason: "modality" as const };
    return toBlock(part, resolved.success.bytes, resolved.success.mime);
  });
}

export function resolveInputParts<E>(input: {
  readonly parts: readonly Gateway.MediaPart[];
  readonly model: Capability.InputModel;
  readonly bytes: PartBytes<E>;
  readonly derive?: PartDerive;
}): Effect.Effect<{ readonly blocks: UserBlock[]; readonly unaccepted: UnacceptedPart<E>[] }> {
  return Effect.gen(function* () {
    const blocks: UserBlock[] = [];
    const text: TextPart[] = [];
    const unaccepted: UnacceptedPart<E>[] = [];
    for (const part of input.parts) {
      const resolved = yield* resolvePart(part, input.model, input.bytes);
      if (!("reason" in resolved)) {
        blocks.push(resolved);
        continue;
      }
      if (resolved.reason === "unresolved" || input.derive === undefined) {
        unaccepted.push(resolved);
        continue;
      }
      const derived = yield* input.derive(part, input.model);
      for (const replacement of derived.parts) {
        const block = yield* resolvePart(replacement, input.model, input.bytes);
        if (!("reason" in block)) blocks.push(block);
        else unaccepted.push(block);
      }
      if (derived.text !== undefined) text.push({ type: "text", text: derived.text });
    }
    return { blocks: [...blocks, ...text], unaccepted };
  });
}

export function resolveMessageParts(
  input: Pick<RunInput, "messages" | "media" | "model" | "events" | "trace" | "now">,
): Effect.Effect<ReadonlyMap<string, readonly UserBlock[]>> {
  return Effect.gen(function* () {
    const blocksById = new Map<string, UserBlock[]>();
    for (const message of input.messages) {
      if (message.info.role !== "user") continue;
      const parts = message.parts.filter((part) => part.type === "file");
      if (parts.length === 0) continue;
      if (input.media === undefined) {
        blocksById.set(message.info.id, parts.map((part) => ({ type: "text", text: Delivery.text([part]) })));
        continue;
      }
      const resolved = yield* resolveInputParts({
        parts, model: input.model, bytes: input.media.bytes, derive: input.media.derive,
      });
      blocksById.set(message.info.id, [
        ...resolved.blocks,
        ...resolved.unaccepted.map(({ part }) => ({ type: "text" as const, text: Delivery.text([part]) })),
      ]);
      for (const missed of resolved.unaccepted) {
        if (missed.reason !== "unresolved") continue;
        input.events.publish(Operational.Events.Warn, {
          traceId: input.trace.traceId, time: input.now(), sessionId: input.trace.sessionId,
          component: "llm.media", msg: "input part unresolved",
          context: { ref: missed.part.ref, kind: missed.part.kind, err: String(missed.cause) },
        });
      }
    }
    return blocksById;
  });
}
