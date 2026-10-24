import type { AttachmentBounds, MediaBytes } from "@oni/channels";
import { NamedError, type Outbound } from "@oni/protocol";
import { z } from "zod";
import { type FilePorts, filesystem } from "../bundles/tools/core/filesystem";

/**
 * The composition root's media resolver (#1497): an outbound media part's
 * `ref` is a path on an attached machine or an https URL, and the channel
 * driver receives bytes only at delivery time. Promise-shaped because the
 * drivers' `MediaResolver` port is; the machine read goes through the same
 * filesystem door the `read` tool uses, never a local path. The read is
 * admitted by the `send_message` call's own policy gate (the parts are in
 * its input) and by the daemon's export enforcement; it does not re-enter
 * the `read` tool's gate.
 */

export const MEDIA_BYTE_CAP = 50 * 1024 * 1024;
const MEDIA_FETCH_TIMEOUT_MS = 30_000;
const REDIRECT_HOPS = 3;

export const MediaRefused = NamedError.create(
  "OniMediaRefused",
  z.object({
    code: z.enum(["scheme", "host", "fetch_failed", "too_large"]),
    ref: z.string(),
    detail: z.string(),
  }),
);
export type MediaRefused = InstanceType<typeof MediaRefused>;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  zip: "application/zip",
  gz: "application/gzip",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  webm: "video/webm",
  mov: "video/quicktime",
};

export function mediaMime(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

type MediaPart = Outbound.Part & { kind: "image" | "file" | "audio" | "video" };

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function declaredMime(part: MediaPart): string | undefined {
  return part.kind === "file" || part.kind === "audio" || part.kind === "video"
    ? part.mime
    : undefined;
}

export function mediaBounds(signal = AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS)): AttachmentBounds {
  return { maxBytes: MEDIA_BYTE_CAP, signal };
}

export function assertMediaSize(ref: string, size: number, maxBytes = MEDIA_BYTE_CAP): void {
  if (size > maxBytes) {
    throw new MediaRefused({ code: "too_large", ref, detail: `${size} exceeds ${maxBytes} bytes` });
  }
}

/** Loopback, link-local and private ranges: the kernel host's own network is never posted to a chat. */
function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^(127|10|0)\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host)
  );
}

function admitUrl(ref: string, url: URL): void {
  if (url.protocol !== "https:")
    throw new MediaRefused({ code: "scheme", ref, detail: `${url.protocol} is not https` });
  if (privateHost(url.hostname))
    throw new MediaRefused({ code: "host", ref, detail: `${url.hostname} is not a public host` });
}

/** Every hop is admitted on its own, so a public URL cannot redirect into http or a private host. */
async function fetchHops(
  ref: string,
  url: URL,
  fetchImpl: MediaFetch,
  signal: AbortSignal,
): Promise<{ response: Response; at: URL }> {
  let current = url;
  for (let hop = 0; hop <= REDIRECT_HOPS; hop += 1) {
    admitUrl(ref, current);
    const response = await fetchImpl(current, {
      redirect: "manual",
      signal,
    }).catch((error) => {
      throw new MediaRefused({ code: "fetch_failed", ref, detail: String(error) });
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null)
      return { response, at: current };
    await response.body?.cancel();
    if (!URL.canParse(location, current.href))
      throw new MediaRefused({
        code: "fetch_failed",
        ref,
        detail: `redirect to an invalid location`,
      });
    current = new URL(location, current);
  }
  throw new MediaRefused({
    code: "fetch_failed",
    ref,
    detail: `more than ${REDIRECT_HOPS} redirects`,
  });
}

/** Reads the body in chunks and stops at the cap, so a chunked or lying server never fills memory. */
async function boundedBody(ref: string, response: Response, bounds: AttachmentBounds): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  try {
    assertMediaSize(ref, Number(response.headers.get("content-length") ?? 0), bounds.maxBytes);
    if (reader === undefined) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      bounds.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      total += value.byteLength;
      assertMediaSize(ref, total, bounds.maxBytes);
      chunks.push(value);
    }
  } catch (error) {
    await reader?.cancel().catch((cancelError) => {
      throw new MediaRefused({ code: "fetch_failed", ref, detail: `${String(error)}; cancel: ${String(cancelError)}` });
    });
    if (error instanceof MediaRefused) throw error;
    throw new MediaRefused({ code: "fetch_failed", ref, detail: String(error) });
  } finally {
    reader?.releaseLock();
  }
}

async function fromUrl(part: MediaPart, url: URL, fetchImpl: MediaFetch, bounds: AttachmentBounds): Promise<MediaBytes> {
  const { response, at } = await fetchHops(part.ref, url, fetchImpl, bounds.signal);
  if (!response.ok) {
    await response.body?.cancel();
    throw new MediaRefused({
      code: "fetch_failed",
      ref: part.ref,
      detail: `HTTP ${response.status}`,
    });
  }
  const bytes = await boundedBody(part.ref, response, bounds);
  const name = part.name ?? (basename(at.pathname) || "download");
  const header = response.headers.get("content-type")?.split(";")[0]?.trim();
  const mime =
    declaredMime(part) ?? (header === undefined || header === "" ? mediaMime(name) : header);
  return { bytes, name, mime };
}

/** The daemon's stat answers before any byte moves, so an oversize file is refused unread. */
async function fromMachine(part: MediaPart, ports: FilePorts): Promise<MediaBytes> {
  const file = filesystem(part.ref, ports);
  const size = await file.size();
  assertMediaSize(part.ref, size);
  const bytes = await file.read();
  const name = part.name ?? basename(part.ref);
  return { bytes, name, mime: declaredMime(part) ?? mediaMime(name) };
}

/**
 * A ref with an authority (`scheme://host/...`) is a URL; everything else is
 * a machine locus, whose own `machineId:/path` prefix would otherwise parse
 * as a URL scheme.
 */
function asUrl(ref: string): URL | undefined {
  const url = URL.canParse(ref) ? new URL(ref) : undefined;
  return url !== undefined && url.host !== "" ? url : undefined;
}

/** The one call shape the resolver makes; a test supplies it without reaching for the whole `fetch` surface. */
export type MediaFetch = (url: URL, init: RequestInit) => Promise<Response>;

export function createMediaResolver(
  ports: FilePorts,
  fetchImpl: MediaFetch = fetch,
) {
  return (part: MediaPart, bounds: AttachmentBounds = mediaBounds()): Promise<MediaBytes> => {
    const url = asUrl(part.ref);
    return url === undefined ? fromMachine(part, ports) : fromUrl(part, url, fetchImpl, bounds);
  };
}
