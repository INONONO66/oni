import { createHash } from "node:crypto";
import { type AttachmentFetch, type AttachmentFetchResult, type AttachmentFetchWithStream, inboundOnce, type MediaBytes } from "@oni/channels";
import { type BusEvent, type Channel, type Gateway, Operational } from "@oni/protocol";
import { type FilePorts, defaultMachineOf, filesystem } from "../bundles/tools/core/filesystem";
import type { ChannelRuntimeDeps } from "../channels";
import { assertMediaSize, createMediaResolver, mediaBounds } from "./media";
import type { InboxStreamWriter } from "./attachment-stream";

export const OWNER_INBOX_BYTE_CAP = 2 * 1024 * 1024 * 1024;
const OWNER_INBOX_TIMEOUT_MS = 30 * 60 * 1000;

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
  readonly media: ReturnType<typeof createMediaResolver>;
  readonly streams?: InboxStreamWriter;
  readonly downloadSignal?: () => AbortSignal;
  readonly publish: BusEvent.Sink["publish"];
  readonly now: () => number;
}

/**
 * The Resident's routing handler with the inbox in front of it. The physical
 * message is claimed first (#1569 lane 6: the bot and the Owner's account can
 * both observe one message), so only the copy that carries the message is
 * downloaded and stored; each instance's own downloader travels with its copy
 * into the claim. A refused or failed admission releases the claim to the
 * next copy, as before.
 */
export function inboxHandler(
  root: AttachmentInbox["root"] | undefined,
  machines: FilePorts["machines"],
  publish: AttachmentInbox["publish"],
  now: AttachmentInbox["now"],
  admit: Channel.MessageHandler,
  streams?: InboxStreamWriter,
  shutdown?: AbortSignal,
): { readonly handler: Channel.MessageHandler; readonly inbox?: ChannelRuntimeDeps["inbox"] } {
  if (root === undefined || machines === undefined) return { handler: inboundOnce(admit) };
  const downloaders = new WeakMap<Channel.InboundMessage, {
    readonly fetch?: AttachmentFetch;
    readonly streamingFetch?: AttachmentFetchWithStream;
  }>();
  const store = withAttachmentInbox({
    root, files: { machines }, media: createMediaResolver({ machines }), publish, now,
    ...(streams === undefined ? {} : { streams }),
    ...(shutdown === undefined ? {} : { downloadSignal: () => shutdown }),
  }, admit);
  return {
    handler: inboundOnce((message) => {
      const source = downloaders.get(message);
      return store(message, source?.fetch, source?.streamingFetch);
    }),
    inbox: (fetch, handler, streamingFetch) => fetch === undefined && streamingFetch === undefined ? handler : (message) => {
      downloaders.set(message, {
        ...(fetch === undefined ? {} : { fetch }),
        ...(streamingFetch === undefined ? {} : { streamingFetch }),
      });
      return handler(message);
    },
  };
}

type Attachment = NonNullable<Gateway.IngressFacts["attachments"]>[number];

/** One path segment: the platform's own name with everything but a conservative character set folded away. */
function safeName(name: string): string {
  const folded = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return folded === "" ? "attachment" : folded.slice(0, 120);
}

function isUrl(ref: string): boolean {
  return URL.canParse(ref) && new URL(ref).host !== "";
}

async function fetchBytes(
  attachment: Attachment,
  fetchRef: AttachmentFetch | undefined,
  inbox: AttachmentInbox,
  signal: AbortSignal,
): Promise<MediaBytes | undefined> {
  const bounds = mediaBounds(signal);
  if (fetchRef !== undefined) {
    const fetched = await fetchRef(attachment.ref, bounds);
    assertMediaSize(attachment.ref, fetched.bytes.byteLength, bounds.maxBytes);
    return { ...fetched, name: attachment.name ?? fetched.name };
  }
  if (!isUrl(attachment.ref)) return undefined;
  const url = new URL(attachment.ref);
  const fetched = await inbox.media({
    kind: "file",
    ref: attachment.ref,
    name: attachment.name ?? (url.pathname.slice(url.pathname.lastIndexOf("/") + 1) || "attachment"),
    ...(attachment.mime === undefined ? {} : { mime: attachment.mime }),
  }, bounds);
  assertMediaSize(attachment.ref, fetched.bytes.byteLength, bounds.maxBytes);
  return fetched;
}

async function fetchStream(
  attachment: Attachment,
  fetchRef: AttachmentFetchWithStream,
  signal: AbortSignal,
): Promise<AttachmentFetchResult> {
  const fetched = await fetchRef(attachment.ref, { maxBytes: OWNER_INBOX_BYTE_CAP, signal });
  if (!("chunks" in fetched)) assertMediaSize(attachment.ref, fetched.bytes.byteLength);
  return { ...fetched, name: attachment.name ?? fetched.name };
}

function storageKey(facts: Gateway.IngressFacts, index: number, ref: string): string {
  return createHash("sha256").update(JSON.stringify([
    facts.surface, facts.receivedBy ?? "bot", facts.workspaceId ?? null,
    facts.channelId, facts.eventId, index, ref,
  ])).digest("hex");
}

/** Wraps the Resident handler so every attachment the inbox can hold is on the machine when the message arrives. */
export function withAttachmentInbox(
  inbox: AttachmentInbox,
  handler: Channel.MessageHandler,
): (message: Channel.InboundMessage, fetchRef?: AttachmentFetch, streamingFetch?: AttachmentFetchWithStream) => Promise<void> {
  const machine = defaultMachineOf(inbox.files);
  const kept = new Map<string, Attachment>();
  const store = async (
    key: string, attachment: Attachment,
    fetchRef: AttachmentFetch | undefined,
    streamingFetch: AttachmentFetchWithStream | undefined,
  ): Promise<Attachment> => {
    const known = kept.get(key);
    if (known !== undefined) return known;
    const signal = AbortSignal.any([
      AbortSignal.timeout(OWNER_INBOX_TIMEOUT_MS),
      ...(inbox.downloadSignal === undefined ? [] : [inbox.downloadSignal()]),
    ]);
    const fetched = streamingFetch === undefined
      ? await fetchBytes(attachment, fetchRef, inbox, signal)
      : await fetchStream(attachment, streamingFetch, signal);
    if (fetched === undefined) return attachment;
    const locus = `${machine}:${inbox.root}/${key}-${safeName(fetched.name)}`;
    let size: number;
    if ("chunks" in fetched) {
      if (!Number.isSafeInteger(fetched.size) || fetched.size < 0 || fetched.size > OWNER_INBOX_BYTE_CAP ||
          inbox.streams === undefined) {
        await fetched.chunks[Symbol.asyncIterator]().return?.();
        throw new Error("inbound attachment stream has invalid size or no machine writer");
      }
      const receipt = await inbox.streams.write(locus, fetched.chunks, {
        create: "exclusive", maxBytes: OWNER_INBOX_BYTE_CAP, expectedBytes: fetched.size, signal,
      });
      size = receipt.bytesWritten;
    } else {
      size = await filesystem(locus, inbox.files).write(fetched.bytes, { create: "exclusive" });
    }
    const stored = {
      ...attachment, ref: locus, name: fetched.name,
      mime: attachment.mime ?? fetched.mime, bytes: size,
    };
    kept.set(key, stored);
    return stored;
  };
  return async (message, fetchRef, streamingFetch) => {
    const attachments = message.facts.attachments;
    if (attachments === undefined || attachments.length === 0) return handler(message);
    const keys: string[] = [];
    const stored: Attachment[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const key = storageKey(message.facts, index, attachment.ref);
      keys.push(key);
      stored.push(await store(key, attachment, fetchRef, streamingFetch).catch((error: Error) => {
        inbox.publish(Operational.Events.Warn, {
          traceId: message.facts.eventId,
          time: inbox.now(),
          component: "server",
          msg: "inbound attachment not stored; reference kept",
          context: { surface: message.facts.surface, ref: attachment.ref, err: String(error) },
        });
        return attachment;
      }));
    }
    await handler({ ...message, facts: { ...message.facts, attachments: stored } });
    for (const key of keys) kept.delete(key);
  };
}
