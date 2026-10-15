import { Outbound } from "@openomni/protocol";
import { DeliveryNotSent } from "../errors";
import type { MediaLimits, RenderPolicy } from "../provider/contract";
import type { MediaBytes, MediaResolver } from "../types";
import { chunkMarkdown } from "./format/chunk";

/**
 * The translation layer (#1497): one `Outbound.Payload` becomes the ordered
 * physical sends a surface can make. Every driver supplies the same three
 * primitives bound to its target; this module owns the folding rules —
 * which parts merge into one text, where media goes, what an unsupported
 * part or action turns into — so no driver carries a copy of them.
 *
 * Folding rules:
 * - Adjacent text/code parts join into one markdown text, rendered through
 *   the surface's dialect and split at its message limit.
 * - An image/file part uploads through `media` where the surface and the
 *   composition root both support it; otherwise its reference line stays in
 *   the text so the person still receives what was meant.
 * - Media bytes resolve before the first send: a bad reference refuses the
 *   whole payload with nothing posted, never a half-delivered letter.
 * - Part, caption, and letter limits refuse the whole payload before sending.
 * - A `react` payload needs `react`; a surface without one refuses it as
 *   not sent (the agent's receipt says `rejected`), never as text. With
 *   `replaces`, the surface takes the sender's earlier emoji off the message
 *   before adding the new one; a platform whose reaction call already
 *   replaces does that in one call.
 */

export class PartialDeliveryError extends Error {
  constructor(
    readonly acceptedChunks: { index: number; externalMessageId: string }[],
    readonly attemptedChunks: number,
    readonly totalChunks: number,
    readonly reason: "missing_receipt" | "send_failed",
    options?: ErrorOptions,
  ) {
    super("partial message delivery", options);
    this.name = "PartialDeliveryError";
  }
}

/** The platform id where the API returns one for an accepted send; slack uploads acknowledge without one. */
interface SendAck {
  readonly externalMessageId?: string;
}

type MediaUpload = (
  kind: "image" | "file",
  bytes: MediaBytes,
  caption: string | undefined,
) => Promise<SendAck>;

/** The bytes one letter may hold in memory before its first send. */
const LETTER_MEDIA_BYTES = 64 * 1024 * 1024;

/** The surface's physical primitives, already bound to the delivery's channel and thread. */
export interface SurfaceSends {
  readonly text: (chunk: string) => Promise<string | undefined>;
  readonly media?: { readonly upload: MediaUpload; readonly limits: MediaLimits };
  readonly react?: (messageId: string, emoji: string, replaces?: string) => Promise<void>;
}

/** `accepted` only when every step was; `externalMessageId` is the last message posted. */
export interface DeliveryOutcome {
  readonly accepted: boolean;
  readonly externalMessageId?: string;
}

type Step =
  | { readonly kind: "text"; readonly chunk: string }
  | {
      readonly kind: "media";
      readonly part: Extract<Outbound.Part, { kind: "image" | "file" }>;
      readonly bytes: MediaBytes;
      readonly upload: MediaUpload;
    };

function textSteps(parts: Outbound.Part[], render: RenderPolicy): Step[] {
  if (parts.length === 0) return [];
  const rendered = render.renderMarkdown(Outbound.text({ kind: "message", parts }));
  const chunks =
    render.messageLimit === null ? [rendered] : chunkMarkdown(rendered, render.messageLimit);
  return chunks.map((chunk) => ({ kind: "text", chunk }));
}

/** Every media reference resolves before the first send so a bad one refuses the letter whole. */
async function plan(
  message: Outbound.Message,
  render: RenderPolicy,
  media:
    | {
        readonly upload: MediaUpload;
        readonly limits: MediaLimits;
        readonly resolve: MediaResolver;
      }
    | undefined,
): Promise<Step[]> {
  const steps: Step[] = [];
  let pending: Outbound.Part[] = [];
  let totalBytes = 0;
  const parts: Outbound.Part[] = Outbound.parts(message);
  for (const part of parts) {
    if (part.kind === "text" || part.kind === "code" || media === undefined) {
      pending.push(part);
      continue;
    }
    steps.push(...textSteps(pending, render));
    pending = [];
    const bytes = await media.resolve(part).catch((error) => {
      throw new DeliveryNotSent({ operation: "media.resolve", cause: String(error) });
    });
    const limit = part.kind === "image" ? media.limits.imageBytes : media.limits.fileBytes;
    if (bytes.bytes.byteLength > limit)
      throw new DeliveryNotSent({
        operation: "media.limit",
        cause: `${bytes.bytes.byteLength} bytes exceeds the ${part.kind} limit ${limit}`,
      });
    if (part.caption !== undefined && part.caption.length > media.limits.captionLength)
      throw new DeliveryNotSent({
        operation: "media.caption",
        cause: `${part.caption.length} characters exceeds the caption limit ${media.limits.captionLength}`,
      });
    totalBytes += bytes.bytes.byteLength;
    if (totalBytes > LETTER_MEDIA_BYTES)
      throw new DeliveryNotSent({
        operation: "media.limit",
        cause: `${totalBytes} bytes exceeds the letter limit ${LETTER_MEDIA_BYTES}`,
      });
    steps.push({ kind: "media", part, bytes, upload: media.upload });
  }
  steps.push(...textSteps(pending, render));
  return steps;
}

async function runStep(step: Step, text: SurfaceSends["text"]): Promise<SendAck> {
  if (step.kind === "media") return step.upload(step.part.kind, step.bytes, step.part.caption);
  const externalMessageId = await text(step.chunk);
  return externalMessageId === undefined ? {} : { externalMessageId };
}

/**
 * Runs the steps in order with the partial-delivery rule: once anything is
 * accepted, a later failure or a missing receipt is reported as partial so
 * the reconciliation never resends what the person already has.
 */
async function runSteps(steps: Step[], text: SurfaceSends["text"]): Promise<DeliveryOutcome> {
  const acceptedChunks: { index: number; externalMessageId: string }[] = [];
  let acknowledged = 0;
  let attempted = 0;
  let lastMessageId: string | undefined;
  for (const step of steps) {
    attempted += 1;
    let ack: SendAck;
    try {
      ack = await runStep(step, text);
    } catch (error) {
      if (attempted > 1)
        throw new PartialDeliveryError(acceptedChunks, attempted, steps.length, "send_failed", {
          cause: error,
        });
      throw error;
    }
    if (ack.externalMessageId !== undefined) {
      lastMessageId = ack.externalMessageId;
      acceptedChunks.push({ index: attempted, externalMessageId: ack.externalMessageId });
    }
    if (ack.externalMessageId !== undefined || step.kind === "media") acknowledged += 1;
  }
  if (acknowledged > 0 && acknowledged !== steps.length)
    throw new PartialDeliveryError(acceptedChunks, attempted, steps.length, "missing_receipt");
  return lastMessageId === undefined
    ? { accepted: acknowledged === steps.length }
    : { accepted: true, externalMessageId: lastMessageId };
}

export async function translate(
  payload: Outbound.Payload,
  render: RenderPolicy,
  sends: SurfaceSends,
  resolve?: MediaResolver,
): Promise<DeliveryOutcome> {
  if (payload.kind === "react") {
    if (sends.react === undefined)
      throw new DeliveryNotSent({ operation: "react", cause: "surface has no reactions" });
    await sends.react(payload.messageId, payload.emoji, payload.replaces);
    return { accepted: true, externalMessageId: payload.messageId };
  }
  const media =
    sends.media === undefined || resolve === undefined ? undefined : { ...sends.media, resolve };
  return runSteps(await plan(payload, render, media), sends.text);
}
