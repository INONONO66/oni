import { Outbound } from "@openomni/protocol";
import { DeliveryNotSent } from "../errors";
import type { MediaLimits, RenderPolicy } from "../provider/contract";
import type { MediaBytes, MediaResolver } from "../types";
import { chunkMarkdown } from "./format/chunk";
import { downgrade, type Downgrade, type Downgraded } from "./downgrade.js";
import { renderElementImage } from "./render-image.js";

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

export interface NativeStep {
  readonly id: string;
  readonly element: Outbound.Element;
  readonly spec: Outbound.Spec;
  readonly digest: string;
  readonly attachments: Readonly<Record<string, MediaBytes>>;
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
  readonly native?: (step: NativeStep) => Promise<SendAck>;
}

/** `accepted` only when every step was; `externalMessageId` is the last message posted. */
export interface DeliveryOutcome {
  readonly accepted: boolean;
  readonly externalMessageId?: string;
}

type Step =
  | { readonly kind: "text"; readonly chunk: string }
  | { readonly kind: "native"; readonly step: NativeStep; readonly send: (step: NativeStep) => Promise<SendAck> }
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

async function planSpec(
  spec: Outbound.Spec,
  render: RenderPolicy,
  sends: SurfaceSends,
  media: { readonly upload: MediaUpload; readonly limits: MediaLimits; readonly resolve: MediaResolver } | undefined,
): Promise<Step[]> {
  const steps: Step[] = [];
  let pending: Outbound.Part[] = [];
  let totalBytes = 0;
  const flush = (): void => { steps.push(...textSteps(pending, render)); pending = []; };
  const resolveImage = async (ref: string, caption?: string, kind: "image" | "file" = "image"): Promise<MediaBytes> => {
    if (media === undefined) throw new DeliveryNotSent({ operation: "media", cause: "no resolver or uploader" });
    const part: Outbound.Part & { kind: "image" | "file" } = kind === "image"
      ? { kind, ref, caption }
      : { kind, ref, name: ref };
    const bytes = await media.resolve(part).catch((error) => {
      throw new DeliveryNotSent({ operation: "media.resolve", cause: String(error) });
    });
    const limit = kind === "image" ? media.limits.imageBytes : media.limits.fileBytes;
    if (bytes.bytes.byteLength > limit)
      throw new DeliveryNotSent({ operation: "media.limit", cause: `${bytes.bytes.byteLength} bytes exceeds the ${kind} limit ${limit}` });
    if (caption !== undefined && caption.length > media.limits.captionLength)
      throw new DeliveryNotSent({ operation: "media.caption", cause: `${caption.length} characters exceeds the caption limit ${media.limits.captionLength}` });
    totalBytes += bytes.bytes.byteLength;
    if (totalBytes > LETTER_MEDIA_BYTES)
      throw new DeliveryNotSent({ operation: "media.limit", cause: `${totalBytes} bytes exceeds the letter limit ${LETTER_MEDIA_BYTES}` });
    return bytes;
  };
  const digest = (id: string, current: Outbound.Spec): string =>
    Outbound.text({ kind: "message", spec: { root: id, elements: current.elements } });
  async function appendImage(result: Extract<Downgraded, { kind: "image" }>): Promise<void> {
    if (media === undefined) {
      pending.push({ kind: "text", text: result.caption });
      return;
    }
    flush();
    if (result.caption.length > media.limits.captionLength)
      throw new DeliveryNotSent({ operation: "media.caption", cause: `${result.caption.length} characters exceeds the caption limit ${media.limits.captionLength}` });
    const bytes = await renderElementImage(result.element, result.caption).catch((error) => {
      throw new DeliveryNotSent({ operation: "image.render", cause: String(error) });
    });
    if (bytes.bytes.byteLength > media.limits.imageBytes)
      throw new DeliveryNotSent({ operation: "media.limit", cause: `${bytes.bytes.byteLength} bytes exceeds the image limit ${media.limits.imageBytes}` });
    totalBytes += bytes.bytes.byteLength;
    if (totalBytes > LETTER_MEDIA_BYTES)
      throw new DeliveryNotSent({ operation: "media.limit", cause: `${totalBytes} bytes exceeds the letter limit ${LETTER_MEDIA_BYTES}` });
    steps.push({ kind: "media", part: { kind: "image", ref: bytes.name, caption: result.caption }, bytes, upload: media.upload });
  }

  async function appendCaptionKeyboard(
    result: Extract<Downgraded, { kind: "caption-keyboard" }>, id: string, current: Outbound.Spec,
  ): Promise<void> {
    if (result.image === undefined || media === undefined)
      pending.push({ kind: "text", text: `${result.caption}${result.image === undefined ? "" : `\n[image] ${result.image}`}` });
    else {
      flush();
      const bytes = await resolveImage(result.image, result.caption);
      steps.push({ kind: "media", part: { kind: "image", ref: result.image, caption: result.caption }, bytes, upload: media.upload });
    }
    if (result.buttons.length === 0) return;
    const buttons: Outbound.Element = { type: "Buttons", props: {}, children: [...result.buttons] };
    const buttonSpec: Outbound.Spec = { root: `${id}:keyboard`, elements: {
      ...current.elements, [`${id}:keyboard`]: buttons,
    } };
    flush();
    if (sends.native === undefined)
      pending.push({ kind: "text", text: result.buttons.map((child) => digest(child, current)).join("\n") });
    else steps.push({ kind: "native", step: { id: buttonSpec.root, element: buttons,
      spec: buttonSpec, digest: digest(buttonSpec.root, buttonSpec), attachments: {} }, send: sends.native });
  }

  async function appendDowngrade(name: Downgrade, id: string, current: Outbound.Spec): Promise<void> {
    const result = downgrade(name, id, current);
    switch (result.kind) {
      case "text":
        pending.push({ kind: "text", text: result.text });
        return;
      case "sequence":
        for (const child of result.ids) await visit(child, result.spec ?? current);
        return;
      case "album": {
        const element = current.elements[id];
        if (sends.native !== undefined && element?.type === "Carousel" && result.ids.every((child) => {
          const card = current.elements[child];
          return card?.type === "Card" && card.props.image?.startsWith("https://");
        })) {
          flush();
          steps.push({ kind: "native", step: {
            id, element, spec: current, digest: digest(id, current), attachments: {},
          }, send: sends.native });
        } else for (const child of result.ids) await visit(child, current);
        return;
      }
      case "caption-keyboard":
        await appendCaptionKeyboard(result, id, current);
        return;
      case "image":
        await appendImage(result);
        return;
    }
  }

  async function appendNative(id: string, element: Outbound.Element, current: Outbound.Spec): Promise<void> {
    if (sends.native === undefined) return;
    flush();
    const attachments: Record<string, MediaBytes> = {};
    if (element.type === "Card" && element.props.image !== undefined && !element.props.image.startsWith("https://")) {
      if (media === undefined) {
        pending.push({ kind: "text", text: `${digest(id, current)}\n[image] ${element.props.image}` });
        return;
      }
      attachments[element.props.image] = await resolveImage(element.props.image);
    }
    steps.push({ kind: "native", step: { id, element, spec: current, digest: digest(id, current), attachments }, send: sends.native });
    if (element.type === "Card" && element.props.image !== undefined && media !== undefined) {
      const bytes = attachments[element.props.image];
      if (bytes !== undefined)
        steps.push({ kind: "media", part: { kind: "image", ref: element.props.image }, bytes, upload: media.upload });
    }
  }

  async function appendMedia(id: string, element: Extract<Outbound.Element, { type: "Image" | "File" }>,
    current: Outbound.Spec, policy: string): Promise<void> {
    if (media === undefined || policy === "text") {
      pending.push({ kind: "text", text: digest(id, current) });
      return;
    }
    flush();
    const part = element.type === "Image"
      ? { kind: "image" as const, ref: element.props.ref, caption: element.props.caption }
      : { kind: "file" as const, ref: element.props.ref, name: element.props.name };
    steps.push({ kind: "media", part, bytes: await resolveImage(part.ref,
      part.kind === "image" ? part.caption : undefined, part.kind), upload: media.upload });
  }

  function hasIncompleteAlbum(element: Outbound.Element, current: Outbound.Spec):
    element is Extract<Outbound.Element, { type: "Carousel" }> {
    if (element.type !== "Carousel") return false;
    return element.children.some((child) => {
      const card = current.elements[child];
      return card?.type !== "Card" || card.props.image === undefined || !card.props.image.startsWith("https://");
    });
  }

  async function visit(id: string, current: Outbound.Spec): Promise<void> {
    const element = current.elements[id];
    if (element === undefined) return;
    const policy = render.capabilities[element.type];
    if (element.type === "Image" || element.type === "File") {
      await appendMedia(id, element, current, policy);
      return;
    }
    if (hasIncompleteAlbum(element, current)) {
      for (const child of element.children) await visit(child, current);
      return;
    }
    if (policy.startsWith("downgrade:")) {
      await appendDowngrade(policy.slice("downgrade:".length) as Downgrade, id, current);
      return;
    }
    if (policy === "text" || sends.native === undefined) {
      const image = element.type === "Card" ? element.props.image : undefined;
      pending.push({ kind: "text", text: digest(id, current) + (image === undefined ? "" : `\n[image] ${image}`) });
      return;
    }
    await appendNative(id, element, current);
  }
  await visit(spec.root, spec);
  flush();
  return steps;
}

/** Every media reference resolves before the first send so a bad one refuses the letter whole. */
async function plan(
  message: Extract<Outbound.Message, { parts: Outbound.Part[] }>,
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
  if (step.kind === "native") return step.send(step.step);
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
  return runSteps(await ("spec" in payload
    ? planSpec(payload.spec, render, sends, media)
    : plan(payload, render, media)), sends.text);
}
