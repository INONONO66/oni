import { z } from "zod";

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
const PartSchema = z.discriminatedUnion("kind", [TextPart, CodePart, ImagePart, FilePart]);

const MessageSchema = z
  .object({ kind: z.literal("message"), parts: z.array(PartSchema).min(1) })
  .strict();
const ReactSchema = z
  .object({ kind: z.literal("react"), messageId: Id, emoji: z.string().min(1) })
  .extend({ remove: z.boolean().optional() })
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
  })
  .strict();

function captionLine(caption: string | undefined): string {
  return caption === undefined ? "" : `\n${caption}`;
}

function partText(part: z.infer<typeof PartSchema>): string {
  switch (part.kind) {
    case "text":
      return part.text;
    case "code":
      return `\`\`\`${part.lang ?? ""}\n${part.text}\n\`\`\``;
    case "image":
      return `[image${part.name === undefined ? "" : `: ${part.name}`}] ${part.ref}${captionLine(part.caption)}`;
    case "file":
      return `[file: ${part.name}] ${part.ref}${captionLine(part.caption)}`;
  }
}

export namespace Outbound {
  export const Part = PartSchema;
  export type Part = z.infer<typeof PartSchema>;
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
   * The text-only reading of a payload: what a session prompt, a journal
   * digest, or a channel without media support carries. Media parts become
   * a bracketed line naming the reference, so nothing is dropped silently.
   */
  export function text(payload: Payload): string {
    if (payload.kind === "react") return `${payload.emoji} on ${payload.messageId}`;
    return payload.parts.map(partText).join("\n\n");
  }
}
