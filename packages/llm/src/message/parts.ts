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
    const unaccepted: UnacceptedPart<E>[] = [];
    for (const part of input.parts) {
      const resolved = yield* resolveFilePart(part, input);
      for (const block of resolved) {
        if ("reason" in block) unaccepted.push(block);
        else blocks.push(block);
      }
    }
    return { blocks, unaccepted };
  });
}

function resolveFilePart<E>(
  part: Gateway.MediaPart,
  input: { readonly model: Capability.InputModel; readonly bytes: PartBytes<E>; readonly derive?: PartDerive },
): Effect.Effect<readonly (UserBlock | UnacceptedPart<E>)[]> {
  return Effect.gen(function* () {
    const resolved = yield* resolvePart(part, input.model, input.bytes);
    if (!("reason" in resolved)) return [resolved];
    if (resolved.reason === "unresolved" || input.derive === undefined) return [resolved];
    const derived = yield* input.derive(part, input.model);
    if (derived.parts.length === 0 && !derived.text?.trim()) return [resolved];
    const replacements: (UserBlock | UnacceptedPart<E>)[] = [];
    for (const replacement of derived.parts) {
      replacements.push(yield* resolvePart(replacement, input.model, input.bytes));
    }
    if (derived.text !== undefined) replacements.push({ type: "text", text: derived.text });
    return replacements;
  });
}

function renderFileBlocks<E>(
  resolved: readonly (UserBlock | UnacceptedPart<E>)[],
  input: Pick<RunInput, "events" | "trace" | "now">,
): UserBlock[] {
  const blocks: UserBlock[] = [];
  for (const block of resolved) {
    if (!("reason" in block)) {
      blocks.push(block);
      continue;
    }
    blocks.push({ type: "text", text: Delivery.text([block.part]) });
    if (block.reason !== "unresolved") continue;
    input.events.publish(Operational.Events.Warn, {
      traceId: input.trace.traceId, time: input.now(), sessionId: input.trace.sessionId,
      component: "llm.media", msg: "input part unresolved",
      context: { ref: block.part.ref, kind: block.part.kind, err: String(block.cause) },
    });
  }
  return blocks;
}

export function resolveMessageParts(
  input: Pick<RunInput, "messages" | "media" | "model" | "events" | "trace" | "now">,
): Effect.Effect<ReadonlyMap<string, readonly UserBlock[]>> {
  return Effect.gen(function* () {
    const blocksById = new Map<string, UserBlock[]>();
    for (const message of input.messages) {
      if (message.info.role !== "user") continue;
      for (const part of message.parts) {
        if (part.type !== "file") continue;
        if (input.media === undefined) {
          blocksById.set(part.id, [{ type: "text", text: Delivery.text([part]) }]);
          continue;
        }
        const resolved = yield* resolveFilePart(part, {
          model: input.model, bytes: input.media.bytes, derive: input.media.derive,
        });
        blocksById.set(part.id, renderFileBlocks(resolved, input));
      }
    }
    return blocksById;
  });
}
