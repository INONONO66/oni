import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
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

/** Loopback, private, shared, link-local, multicast and reserved ranges; IPv4-mapped IPv6 is checked against the IPv4 rows. */
const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE_RANGES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const)
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv6");

/** The resolved destination one hop connects to. */
interface MediaAddress {
  readonly address: string;
  readonly family: number;
}
export type MediaLookup = (hostname: string) => Promise<readonly MediaAddress[]>;

function lookupAll(hostname: string): Promise<readonly MediaAddress[]> {
  return lookup(hostname, { all: true });
}

function admitScheme(ref: string, url: URL): void {
  if (url.protocol !== "https:")
    throw new MediaRefused({ code: "scheme", ref, detail: `${url.protocol} is not https` });
}

/**
 * Every resolved address must be public: a name that resolves to the kernel
 * host's own network is refused, and the connection goes to the admitted
 * address rather than to a second, unchecked resolution.
 */
async function admitAddress(ref: string, url: URL, lookupImpl: MediaLookup, signal: AbortSignal): Promise<MediaAddress> {
  if (signal.aborted)
    throw new MediaRefused({ code: "fetch_failed", ref, detail: String(signal.reason) });
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  let addresses: readonly MediaAddress[];
  if (family === 0) {
    const onAbort = () => abort.reject(signal.reason);
    const abort = Promise.withResolvers<readonly MediaAddress[]>();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      addresses = await Promise.race([Promise.resolve().then(() => lookupImpl(host)), abort.promise]);
    } catch (error) {
      throw new MediaRefused({ code: "fetch_failed", ref, detail: String(error) });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  } else {
    addresses = [{ address: host, family }];
  }
  if (signal.aborted)
    throw new MediaRefused({ code: "fetch_failed", ref, detail: String(signal.reason) });
  const refused = addresses.find((entry) => PRIVATE_RANGES.check(entry.address, entry.family === 6 ? "ipv6" : "ipv4"));
  const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  if (refused !== undefined || chosen === undefined)
    throw new MediaRefused({ code: "host", ref, detail: `${url.hostname} is not a public host` });
  return chosen;
}

/** Connects to the admitted address; the Host header and the TLS server name (which the certificate is verified against) keep the URL's own name. */
const pinnedFetch: MediaFetch = (url, init, address) => {
  const pinned = new URL(url);
  pinned.hostname = address.family === 6 ? `[${address.address}]` : address.address;
  const options: BunFetchRequestInit = {
    ...init,
    headers: { host: url.host },
    tls: { serverName: url.hostname },
  };
  return fetch(pinned, options);
};

/** Every hop is admitted on its own, so a public URL cannot redirect into http or a private address. */
async function fetchHops(
  ref: string,
  url: URL,
  transport: { readonly fetch: MediaFetch; readonly lookup: MediaLookup },
  signal: AbortSignal,
): Promise<{ response: Response; at: URL }> {
  let current = url;
  for (let hop = 0; hop <= REDIRECT_HOPS; hop += 1) {
    admitScheme(ref, current);
    const address = await admitAddress(ref, current, transport.lookup, signal);
    const response = await transport.fetch(current, { redirect: "manual", signal }, address).catch((error: Error) => {
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
async function readCapped(
  ref: string,
  response: Response,
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
  bounds: AttachmentBounds,
): Promise<Uint8Array> {
  assertMediaSize(ref, Number(response.headers.get("content-length") ?? 0), bounds.maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  bounds.signal.throwIfAborted();
  let next = await reader.read();
  while (!next.done) {
    total += next.value.byteLength;
    assertMediaSize(ref, total, bounds.maxBytes);
    chunks.push(next.value);
    bounds.signal.throwIfAborted();
    next = await reader.read();
  }
  return Buffer.concat(chunks);
}

/** A refused or interrupted read cancels the stream before the refusal leaves. */
function boundedBody(ref: string, response: Response, bounds: AttachmentBounds): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    assertMediaSize(ref, Number(response.headers.get("content-length") ?? 0), bounds.maxBytes);
    bounds.signal.throwIfAborted();
    return Promise.resolve(new Uint8Array());
  }
  return readCapped(ref, response, reader, bounds)
    .catch(async (error: Error) => {
      await reader.cancel().catch((cancelError: Error) => {
        throw new MediaRefused({ code: "fetch_failed", ref, detail: `${String(error)}; cancel: ${String(cancelError)}` });
      });
      throw error instanceof MediaRefused ? error : new MediaRefused({ code: "fetch_failed", ref, detail: String(error) });
    })
    .finally(() => reader.releaseLock());
}

async function fromUrl(
  part: MediaPart,
  url: URL,
  transport: { readonly fetch: MediaFetch; readonly lookup: MediaLookup },
  bounds: AttachmentBounds,
): Promise<MediaBytes> {
  const { response, at } = await fetchHops(part.ref, url, transport, bounds.signal);
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

/** The one call shape the resolver makes: the hop's URL, its request options and the address it was admitted at. */
export type MediaFetch = (url: URL, init: RequestInit, address: MediaAddress) => Promise<Response>;

export function createMediaResolver(
  ports: FilePorts,
  fetchImpl: MediaFetch = pinnedFetch,
  lookupImpl: MediaLookup = lookupAll,
) {
  const transport = { fetch: fetchImpl, lookup: lookupImpl };
  return (part: MediaPart, bounds: AttachmentBounds = mediaBounds()): Promise<MediaBytes> => {
    const url = asUrl(part.ref);
    return url === undefined ? fromMachine(part, ports) : fromUrl(part, url, transport, bounds);
  };
}
