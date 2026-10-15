import { Outbound } from "@openomni/protocol";
import { DeliveryNotSent } from "../errors";
import type { MediaLimits, RenderPolicy } from "../provider/contract";
import type { MediaBytes, MediaResolver } from "../types";
import { chunkMarkdown } from "./format/chunk";
import { cardCaption, DOWNGRADE_NAMES, downgrade, type Downgrade, type Downgraded } from "./downgrade.js";
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
}

type MediaUpload = (
  kind: "image" | "file",
  bytes: MediaBytes,
  caption: string | undefined,
) => Promise<SendAck>;

/** The bytes one letter may hold in memory before its first send. */
const LETTER_MEDIA_BYTES = 64 * 1024 * 1024;

/** The surface's physical primitives, already bound to the delivery's channel and thread. */
export interface SurfaceSends<TNative = NativeStep> {
  readonly text: (chunk: string) => Promise<string | undefined>;
  readonly media?: { readonly upload: MediaUpload; readonly limits: MediaLimits };
  readonly react?: (messageId: string, emoji: string, replaces?: string) => Promise<void>;
  readonly native?: {
    readonly render: (step: NativeStep) => TNative;
    readonly post: (body: TNative) => Promise<SendAck>;
  };
}

/** `accepted` only when every step was; `externalMessageId` is the last message posted. */
export interface DeliveryOutcome {
  readonly accepted: boolean;
  readonly externalMessageId?: string;
}

type TextOrMediaStep =
  | { readonly kind: "text"; readonly chunk: string }
  | {
      readonly kind: "media";
      readonly part: Extract<Outbound.Part, { kind: "image" | "file" }>;
      readonly bytes: MediaBytes;
      readonly upload: MediaUpload;
    };
type Step<TNative> = TextOrMediaStep
  | { readonly kind: "native"; readonly body: TNative; readonly post: (body: TNative) => Promise<SendAck> };

function textSteps(parts: Outbound.Part[], render: RenderPolicy): TextOrMediaStep[] {
  if (parts.length === 0) return [];
  const markdown = Outbound.text({ kind: "message", parts });
  if (render.messageLimit === null)
    return [{ kind: "text", chunk: render.renderMarkdown(markdown) }];
  const source = chunkMarkdown(markdown, render.messageLimit);
  const chunks: TextOrMediaStep[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const original = source[index] ?? "";
    const chunk = render.renderMarkdown(original);
    if (chunk.length <= render.messageLimit) {
      chunks.push({ kind: "text", chunk });
      continue;
    }
    if (original.length <= 64)
      throw new DeliveryNotSent({ operation: "text.limit", cause: "rendered markup exceeds message limit" });
    source.splice(index, 1, ...chunkMarkdown(original, Math.max(64, Math.ceil(original.length / 2))));
    index -= 1;
  }
  return chunks;
}

async function planSpec<TNative>(
  spec: Outbound.Spec,
  render: RenderPolicy,
  sends: SurfaceSends<TNative>,
  media: { readonly upload: MediaUpload; readonly limits: MediaLimits; readonly resolve: MediaResolver } | undefined,
): Promise<Step<TNative>[]> {
  const steps: Step<TNative>[] = [];
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
  function appendNativeBody(id: string, element: Outbound.Element, current: Outbound.Spec): void {
    if (sends.native === undefined) return;
    const step: NativeStep = { id, element, spec: current, digest: digest(id, current) };
    steps.push({ kind: "native", body: sends.native.render(step), post: sends.native.post });
  }
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
    else appendNativeBody(buttonSpec.root, buttons, buttonSpec);
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
          appendNativeBody(id, element, current);
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
    if (element.type === "Card" && element.props.image !== undefined && !element.props.image.startsWith("https://")) {
      if (media === undefined) {
        pending.push({ kind: "text", text: digest(id, current) });
        return;
      }
      const caption = cardCaption(element);
      const bytes = await resolveImage(element.props.image, caption);
      steps.push({ kind: "media", part: { kind: "image", ref: element.props.image, caption },
        bytes, upload: media.upload });
      return;
    }
    appendNativeBody(id, element, current);
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

  function hasIncompleteAlbum(element: Outbound.Element, current: Outbound.Spec): boolean {
    if (element.type !== "Carousel") return false;
    return element.children.some((child) => {
      const card = current.elements[child];
      return card?.type !== "Card" || card.props.image === undefined || !card.props.image.startsWith("https://");
    });
  }

  async function visitCardChildren(element: Outbound.Element, current: Outbound.Spec): Promise<void> {
    if (element.type === "Card")
      for (const child of element.children) await visit(child, current);
    if (element.type === "Carousel")
      for (const cardId of element.children) {
        const card = current.elements[cardId];
        if (card?.type === "Card")
          for (const child of card.children) await visit(child, current);
      }
  }

  async function visitElement(id: string, element: Outbound.Element, current: Outbound.Spec): Promise<void> {
    const policy = render.capabilities[element.type];
    if (element.type === "Image" || element.type === "File") {
      await appendMedia(id, element, current, policy);
      return;
    }
    const name = DOWNGRADE_NAMES.find((candidate) => policy === `downgrade:${candidate}`);
    if (name !== undefined) {
      await appendDowngrade(name, id, current);
      if (name === "card-to-image") await visitCardChildren(element, current);
      return;
    }
    if (policy === "text" || sends.native === undefined) {
      const image = element.type === "Card" ? element.props.image : undefined;
      pending.push({ kind: "text", text: digest(id, current) + (image === undefined ? "" : `\n[image] ${image}`) });
      return;
    }
    await appendNative(id, element, current);
    await visitCardChildren(element, current);
  }

  async function visit(id: string, current: Outbound.Spec): Promise<void> {
    const element = current.elements[id];
    if (element === undefined) return;
    if (element.type === "Stack" || hasIncompleteAlbum(element, current)) {
      for (const child of element.children) await visit(child, current);
      return;
    }
    await visitElement(id, element, current);
  }
  await visit(spec.root, spec);
  flush();
  return steps;
}

/** Every media reference resolves before the first send so a bad one refuses the letter whole. */
async function plan(
  parts: Outbound.Part[],
  render: RenderPolicy,
  media:
    | {
        readonly upload: MediaUpload;
        readonly limits: MediaLimits;
        readonly resolve: MediaResolver;
      }
    | undefined,
): Promise<TextOrMediaStep[]> {
  const steps: TextOrMediaStep[] = [];
  let pending: Outbound.Part[] = [];
  let totalBytes = 0;
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

async function runStep<TNative>(step: Step<TNative>, text: SurfaceSends["text"]): Promise<SendAck> {
  if (step.kind === "media") return step.upload(step.part.kind, step.bytes, step.part.caption);
  if (step.kind === "native") return step.post(step.body);
  const externalMessageId = await text(step.chunk);
  return externalMessageId === undefined ? {} : { externalMessageId };
}

/**
 * Runs the steps in order with the partial-delivery rule: once anything is
 * accepted, a later failure or a missing receipt is reported as partial so
 * the reconciliation never resends what the person already has.
 */
async function runSteps<TNative>(steps: Step<TNative>[], text: SurfaceSends["text"]): Promise<DeliveryOutcome> {
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

export async function translate<TNative>(
  payload: Outbound.Payload,
  render: RenderPolicy,
  sends: SurfaceSends<TNative>,
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
  return runSteps(await (payload.spec !== undefined
    ? planSpec(payload.spec, render, sends, media)
    : plan(payload.parts ?? [], render, media)), sends.text);
}
