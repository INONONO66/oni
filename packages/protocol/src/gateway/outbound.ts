import { z } from "zod";
import * as catalogModule from "./catalog.js";

/**
 * The one outbound value an agent produces for a person (#1497): a letter
 * made of parts, or one reaction. Every door — the `send_message` tool, the
 * turn-end report, an automation reply — folds into this shape, and every
 * channel translates it into the platform's own calls from its declared
 * capabilities. Platform vocabulary (threads, mrkdwn, attachments, emoji
 * names) never appears here.
 */

const Id = z.string().min(1);

/**
 * Where an image's or file's bytes live: a path on the attached machine or
 * an `https` URL. The composition root resolves it at delivery time; the
 * letter's journal row carries the reference only, never the bytes.
 */
const Ref = z.string().min(1);

const TextPart = z.object({ kind: z.literal("text"), text: z.string().min(1) }).strict();
const CodePart = z
  .object({ kind: z.literal("code"), text: z.string().min(1), lang: Id.optional() })
  .strict();
const ImagePart = z
  .object({ kind: z.literal("image"), ref: Ref, name: Id.optional(), caption: z.string().optional() })
  .strict();
const FilePart = z
  .object({ kind: z.literal("file"), ref: Ref, name: Id, mime: Id.optional(), caption: z.string().optional() })
  .strict();
const AudioPart = z.object({ kind: z.literal("audio"), ...catalogModule.AudioProps.shape }).strict();
const VideoPart = z.object({ kind: z.literal("video"), ...catalogModule.VideoProps.shape }).strict();
const PartSchema = z.discriminatedUnion("kind", [TextPart, CodePart, ImagePart, FilePart, AudioPart, VideoPart]);

/** A letter is ordered parts or one catalog spec (#1545), never both. */
const MessageSchema = z
  .object({ kind: z.literal("message"), parts: z.array(PartSchema).min(1).optional(), spec: catalogModule.Spec.optional() })
  .strict()
  .superRefine((message, ctx) => {
    if ((message.parts === undefined) === (message.spec === undefined)) {
      ctx.addIssue({ code: "custom", message: "a message carries exactly one of parts or spec" });
    }
  });
/** One emoji on the contact's message; `replaces` names the sender's earlier emoji the platform must take off first. */
const ReactSchema = z
  .object({ kind: z.literal("react"), messageId: Id, emoji: z.string().min(1), replaces: z.string().min(1).optional() })
  .strict();
const PayloadSchema = z.discriminatedUnion("kind", [MessageSchema, ReactSchema]);

/**
 * What a channel reports after translating one payload: whether the platform
 * took it, and the id of the last message it posted — the one a reply
 * quotes. A reaction reports the id of the message it sits on.
 */
const ReceiptSchema = z
  .object({
    value: z.enum(["accepted", "rejected", "unknown"]),
    externalMessageId: Id.optional(),
    /** Why a send was rejected, when the refusal names a limit the sender can respect next time. */
    reason: z.string().optional(),
  })
  .strict();

function captionLine(caption: string | undefined): string {
  return caption === undefined ? "" : `\n${caption}`;
}

type MessagePart = z.infer<typeof PartSchema>;

function partText(part: MessagePart): string {
  switch (part.kind) {
    case "text":
      return part.text;
    case "code":
      return `\`\`\`${part.lang ?? ""}\n${part.text}\n\`\`\``;
    case "image":
      return `[image${part.name === undefined ? "" : `: ${part.name}`}] ${part.ref}${captionLine(part.caption)}`;
    case "file":
      return `[file: ${part.name}] ${part.ref}${captionLine(part.caption)}`;
    case "audio":
      return `${part.voice === true ? "[voice]" : `[audio${part.name === undefined ? "" : `: ${part.name}`}]`} ${part.ref}${captionLine(part.caption)}`;
    case "video":
      return `[video${part.name === undefined ? "" : `: ${part.name}`}] ${part.ref}${captionLine(part.caption)}`;
  }
}

/** One element's reading: text lines, and the media parts a channel can upload. */
type Chunk = string | MessagePart;

function tableChunk(props: { columns: { header: string }[]; rows: string[][] }): string {
  return [props.columns.map((column) => column.header).join(" | "), ...props.rows.map((row) => row.join(" | "))].join("\n");
}

function mediaFields({ name, mime, caption, durationMs }: z.infer<typeof catalogModule.VideoProps>) {
  return {
    ...(name === undefined ? {} : { name }),
    ...(mime === undefined ? {} : { mime }),
    ...(caption === undefined ? {} : { caption }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function buttonChunk(element: Extract<catalogModule.Element, { type: "Button" }>): Chunk[] {
  return ["url" in element.props ? `[${element.props.label}](${element.props.url})` : `[${element.props.label}]`];
}

function cardChunks(element: Extract<catalogModule.Element, { type: "Card" }>): Chunk[] {
  const { title, image, body } = element.props;
  const picture: Chunk[] = image === undefined ? [] : [{ kind: "image", ref: image }];
  return [title, ...picture, ...(body === undefined ? [] : [body])];
}

function pollChunk(element: Extract<catalogModule.Element, { type: "Poll" }>): Chunk[] {
  const options = element.props.options.map((option) => `- ${option}`).join("\n");
  return [`${element.props.question}${element.props.multi === true ? " (choose any)" : ""}\n${options}`];
}

function statusChunks(element: Extract<catalogModule.Element, { type: "Status" }>): Chunk[] {
  return [
    `${element.props.kind.toUpperCase()}: ${element.props.title}`,
    ...(element.props.body === undefined ? [] : [element.props.body]),
  ];
}

function elementChunks(element: catalogModule.Element): Chunk[] {
  switch (element.type) {
    case "Markdown":
    case "Context":
      return [element.props.text];
    case "Code": {
      const { text, lang } = element.props;
      return [lang === undefined ? { kind: "code", text } : { kind: "code", text, lang }];
    }
    case "Table":
      return [tableChunk(element.props)];
    case "Image": {
      const { ref, caption } = element.props;
      return [caption === undefined ? { kind: "image", ref } : { kind: "image", ref, caption }];
    }
    case "File": {
      const { ref, name, mime } = element.props;
      return [mime === undefined ? { kind: "file", ref, name } : { kind: "file", ref, name, mime }];
    }
    case "Audio": {
      const { ref, voice } = element.props;
      return [{ kind: "audio", ref, ...mediaFields(element.props), ...(voice === undefined ? {} : { voice }) }];
    }
    case "Video":
      return [{ kind: "video", ref: element.props.ref, ...mediaFields(element.props) }];
    case "Button":
      return buttonChunk(element);
    case "Card":
      return cardChunks(element);
    case "Poll":
      return pollChunk(element);
    case "Status":
      return statusChunks(element);
    case "Divider":
      return ["---"];
    default:
      return [];
  }
}

/** The spec read depth-first as parts: runs of text collapse into one text part, and media keeps its own part so a channel still uploads it. */
function specParts(spec: catalogModule.Spec): MessagePart[] {
  const parts: MessagePart[] = [];
  const lines: string[] = [];
  const flush = (): void => {
    if (lines.length === 0) return;
    parts.push({ kind: "text", text: lines.join("\n\n") });
    lines.length = 0;
  };
  const pending: string[] = [spec.root];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    const element = spec.elements[id];
    if (element === undefined) continue;
    for (const chunk of elementChunks(element)) {
      if (typeof chunk === "string") {
        lines.push(chunk);
        continue;
      }
      flush();
      parts.push(chunk);
    }
    for (const child of [...element.children].reverse()) pending.push(child);
  }
  flush();
  return parts;
}

export namespace Outbound {
  export const Part = PartSchema;
  export type Part = z.infer<typeof PartSchema>;
  export const catalog = catalogModule.Catalog;
  export import Spec = catalogModule.Spec;
  export import Element = catalogModule.Element;
  export import ElementType = catalogModule.ElementType;
  export const Message = MessageSchema;
  export type Message = z.infer<typeof MessageSchema>;
  export const React = ReactSchema;
  export type React = z.infer<typeof ReactSchema>;
  export const Payload = PayloadSchema;
  export type Payload = z.infer<typeof PayloadSchema>;
  export const Receipt = ReceiptSchema;
  export type Receipt = z.infer<typeof ReceiptSchema>;

  /** A plain string is sugar for one text part; a payload passes through. */
  export function payload(content: string | Payload): Payload {
    return typeof content === "string"
      ? { kind: "message", parts: [{ kind: "text", text: content }] }
      : content;
  }

  /**
   * The parts a channel delivers: the letter's own parts, or the spec read
   * depth-first so its code, images, and files stay uploadable parts rather
   * than flattened text.
   */
  export function parts(message: Message): Part[] {
    return message.spec === undefined ? (message.parts ?? []) : specParts(message.spec);
  }

  /**
   * The text-only reading of a payload: what a session prompt, a journal
   * digest, or a channel without media support carries. Media parts become
   * a bracketed line naming the reference, so nothing is dropped silently.
   */
  export function text(payload: Payload): string {
    if (payload.kind === "react") return `${payload.emoji} on ${payload.messageId}`;
    return parts(payload).map(partText).join("\n\n");
  }

  export function prompt(): string {
    return catalogModule.Catalog.prompt();
  }
}
