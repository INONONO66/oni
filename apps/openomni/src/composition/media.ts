import type { MediaBytes, MediaResolver } from "@openomni/channels";
import { NamedError, type Outbound } from "@openomni/protocol";
import { z } from "zod";
import { type FilePorts, filesystem } from "../bundles/tools/core/filesystem";

/**
 * The composition root's media resolver (#1497): an image or file part's
 * `ref` is a path on an attached machine or an https URL, and the channel
 * driver receives bytes only at delivery time. Promise-shaped because the
 * drivers' `MediaResolver` port is; the machine read goes through the same
 * filesystem door the `read` tool uses, never a local path.
 */

export const MEDIA_BYTE_CAP = 50 * 1024 * 1024;

export const MediaRefused = NamedError.create(
  "OpenOmniMediaRefused",
  z.object({
    code: z.enum(["scheme", "fetch_failed", "too_large"]),
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
  ogg: "audio/ogg",
  wav: "audio/wav",
};

export function mediaMime(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

type MediaPart = Outbound.Part & { kind: "image" | "file" };

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function declaredMime(part: MediaPart): string | undefined {
  return part.kind === "file" ? part.mime : undefined;
}

function sized(ref: string, bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > MEDIA_BYTE_CAP)
    throw new MediaRefused({ code: "too_large", ref, detail: `${bytes.byteLength} bytes exceeds ${MEDIA_BYTE_CAP}` });
  return bytes;
}

async function fromUrl(part: MediaPart, url: URL, fetchImpl: typeof fetch): Promise<MediaBytes> {
  if (url.protocol !== "https:")
    throw new MediaRefused({ code: "scheme", ref: part.ref, detail: `${url.protocol} is not https` });
  const response = await fetchImpl(url).catch((error: unknown) => {
    throw new MediaRefused({ code: "fetch_failed", ref: part.ref, detail: String(error) });
  });
  if (!response.ok)
    throw new MediaRefused({ code: "fetch_failed", ref: part.ref, detail: `HTTP ${response.status}` });
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MEDIA_BYTE_CAP)
    throw new MediaRefused({ code: "too_large", ref: part.ref, detail: `${declared} bytes exceeds ${MEDIA_BYTE_CAP}` });
  const bytes = sized(part.ref, new Uint8Array(await response.arrayBuffer()));
  const name = part.name ?? (basename(url.pathname) || "download");
  const header = response.headers.get("content-type")?.split(";")[0]?.trim();
  const mime = declaredMime(part) ?? (header === undefined || header === "" ? mediaMime(name) : header);
  return { bytes, name, mime };
}

async function fromMachine(part: MediaPart, ports: FilePorts): Promise<MediaBytes> {
  const bytes = sized(part.ref, await filesystem(part.ref, ports).read());
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

export function createMediaResolver(ports: FilePorts, fetchImpl: typeof fetch = fetch): MediaResolver {
  return (part) => {
    const url = asUrl(part.ref);
    return url === undefined ? fromMachine(part, ports) : fromUrl(part, url, fetchImpl);
  };
}
