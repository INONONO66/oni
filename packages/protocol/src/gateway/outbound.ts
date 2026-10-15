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
const PartSchema = z.discriminatedUnion("kind", [TextPart, CodePart, ImagePart, FilePart]);

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

function specText(spec: catalogModule.Spec): string {
  const lines: string[] = [];
  const visit = (id: string): void => {
    const element = spec.elements[id];
    if (element === undefined) return;
    switch (element.type) {
      case "Markdown":
      case "Context":
        lines.push(element.props.text);
        break;
      case "Code":
        lines.push(`\`\`\`${element.props.lang ?? ""}\n${element.props.text}\n\`\`\``);
        break;
      case "Table":
        lines.push([
          element.props.columns.map((column) => column.header).join(" | "),
          ...element.props.rows.map((row) => row.join(" | ")),
        ].join("\n"));
        break;
      case "Buttons":
        break;
      case "Button":
        lines.push(`[${element.props.label}]`);
        break;
      case "Status":
        lines.push(`${element.props.kind.toUpperCase()}: ${element.props.title}`);
        if (element.props.body !== undefined) lines.push(element.props.body);
        break;
      case "Image":
        lines.push(`[image] ${element.props.ref}${element.props.caption === undefined ? "" : `\n${element.props.caption}`}`);
        break;
      case "File":
        lines.push(`[file: ${element.props.name}] ${element.props.ref}`);
        break;
      case "Card":
        lines.push(element.props.title);
        if (element.props.body !== undefined) lines.push(element.props.body);
        break;
      case "Stack":
      case "Carousel":
        break;
      case "Poll":
        lines.push(`${element.props.question}\n${element.props.options.map((option) => `- ${option}`).join("\n")}`);
        break;
      case "Divider":
        lines.push("---");
        break;
    }
    for (const child of element.children) visit(child);
  };
  visit(spec.root);
  return lines.join("\n\n");
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
   * The text-only reading of a payload: what a session prompt, a journal
   * digest, or a channel without media support carries. Media parts become
   * a bracketed line naming the reference, so nothing is dropped silently.
   */
  export function text(payload: Payload): string {
    if (payload.kind === "react") return `${payload.emoji} on ${payload.messageId}`;
    if (payload.spec !== undefined) return specText(payload.spec);
    return (payload.parts ?? []).map(partText).join("\n\n");
  }

  export function prompt(): string {
    return catalogModule.Catalog.prompt();
  }
}
