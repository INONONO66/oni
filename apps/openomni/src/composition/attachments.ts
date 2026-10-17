import type { AttachmentFetch, MediaResolver } from "@openomni/channels";
import { type BusEvent, type Channel, type Gateway, Operational } from "@openomni/protocol";
import { type FilePorts, defaultMachineOf, filesystem } from "../bundles/tools/core/filesystem";

/**
 * Inbound attachments land on the attached machine before the Resident sees
 * the message (#1569 follow-up): a platform reference (a CDN URL, a
 * `file_id`, a private URL) is nothing the `read` tool can open, so each one
 * is fetched once — through the provider's own authenticated download where
 * the platform needs a token, else through the composition's media resolver
 * for a public URL — written flat under the configured inbox directory of
 * the default machine, and the message carries the machine locus instead.
 * A failed fetch keeps the original reference and warns; the message itself
 * is never lost over its attachments.
 */

export interface AttachmentInbox {
  /** Existing absolute directory on the default machine. */
  readonly root: string;
  readonly files: FilePorts;
  readonly media: MediaResolver;
  readonly publish: BusEvent.Sink["publish"];
  readonly now: () => number;
}

type Attachment = NonNullable<Gateway.IngressFacts["attachments"]>[number];

/** One path segment: the platform's own name with everything but a conservative character set folded away. */
function safeName(name: string): string {
  const folded = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return folded === "" ? "attachment" : folded;
}

function isUrl(ref: string): boolean {
  return URL.canParse(ref) && new URL(ref).host !== "";
}

async function fetchBytes(
  attachment: Attachment,
  fetchRef: AttachmentFetch | undefined,
  media: MediaResolver,
): Promise<{ bytes: Uint8Array; name: string } | undefined> {
  if (fetchRef !== undefined) {
    const fetched = await fetchRef(attachment.ref);
    return { bytes: fetched.bytes, name: attachment.name ?? fetched.name };
  }
  if (!isUrl(attachment.ref)) return undefined;
  const url = new URL(attachment.ref);
  const fetched = await media({
    kind: "file",
    ref: attachment.ref,
    name: attachment.name ?? (url.pathname.slice(url.pathname.lastIndexOf("/") + 1) || "attachment"),
    ...(attachment.mime === undefined ? {} : { mime: attachment.mime }),
  });
  return { bytes: fetched.bytes, name: fetched.name };
}

/** Wraps the Resident handler so every attachment the inbox can hold is on the machine when the message arrives. */
export function withAttachmentInbox(
  inbox: AttachmentInbox,
  fetchRef: AttachmentFetch | undefined,
  handler: Channel.MessageHandler,
): Channel.MessageHandler {
  const machine = defaultMachineOf(inbox.files);
  return async (message) => {
    const attachments = message.facts.attachments;
    if (attachments === undefined || attachments.length === 0) return handler(message);
    const stored: Attachment[] = [];
    for (const [index, attachment] of attachments.entries()) {
      try {
        const fetched = await fetchBytes(attachment, fetchRef, inbox.media);
        if (fetched === undefined) {
          stored.push(attachment);
          continue;
        }
        const locus = `${machine}:${inbox.root}/${safeName(`${message.facts.eventId}-${index}-${fetched.name}`)}`;
        await filesystem(locus, inbox.files).write(fetched.bytes);
        stored.push({ ...attachment, ref: locus, name: fetched.name, bytes: fetched.bytes.byteLength });
      } catch (error) {
        inbox.publish(Operational.Events.Warn, {
          traceId: message.facts.eventId,
          time: inbox.now(),
          component: "server",
          msg: "inbound attachment not stored; reference kept",
          context: { surface: message.facts.surface, ref: attachment.ref, err: String(error) },
        });
        stored.push(attachment);
      }
    }
    return handler({ ...message, facts: { ...message.facts, attachments: stored } });
  };
}
