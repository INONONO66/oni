import { Capability, type DerivedPart, type PartBytes, type PartDerive, type Stt } from "@oni/llm";
import { type Gateway, NamedError } from "@oni/protocol";
import { Effect, Result } from "effect";
import { z } from "zod";
import { type FilePorts, defaultMachineOf, filesystem } from "../bundles/tools/core/filesystem";
import { parseLocus } from "../bundles/tools/locus/index";
import { CauseText } from "../thrown";
import { MEDIA_BYTE_CAP, mediaMime } from "./media";

export const PartUnreadable = NamedError.create(
  "OniPartUnreadable",
  z.object({
    code: z.enum(["not_inbox", "too_large", "read_failed"]),
    ref: z.string(),
    detail: z.string(),
  }),
);
type PartUnreadable = InstanceType<typeof PartUnreadable>;

const unreadable = (ref: string) =>
  z.union([
    z.instanceof(PartUnreadable),
    CauseText.transform((detail) => new PartUnreadable({ code: "read_failed", ref, detail })),
  ]).parse;

export interface MediaWarning {
  readonly code: "ffmpeg_missing" | "frames_failed" | "transcript_failed" | "model_unresolved";
  readonly ref: string;
  readonly detail: string;
}

type Attachment = Gateway.MediaPart;
type Machines = NonNullable<FilePorts["machines"]>;

const MAX_FRAMES = 8;

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

const EBML = "\x1a\x45\xdf\xa3";

/** A sniffer answers over a header string with one char per byte; `undefined` means not this format. */
type Sniffer = (header: string, bytes: Uint8Array) => string | undefined;

const prefixed = (mime: string, ...prefixes: readonly string[]): Sniffer => (header) =>
  prefixes.some((prefix) => header.startsWith(prefix)) ? mime : undefined;
const riff = (form: string, mime: string): Sniffer => (header) =>
  header.startsWith("RIFF") && header.slice(8, 12) === form ? mime : undefined;
const ebml = (doctype: string, mime: string): Sniffer => (header) =>
  header.startsWith(EBML) && header.includes(doctype) ? mime : undefined;

/** An MPEG audio frame header with a reserved version, layer, bitrate or sampling field is not audio. */
function mpegFrameSync(bytes: Uint8Array): boolean {
  const second = bytes[1] ?? 0;
  const third = bytes[2] ?? 0;
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  return bytes[0] === 0xff && (second & 0xe0) === 0xe0 && version !== 1 && layer !== 0 && third >> 4 !== 0x0f && ((third >> 2) & 0x03) !== 3;
}

/** ISO-BMFF `ftyp` only proves a container; the major brand names the media, and an unlisted brand sniffs nothing. */
const FTYP_BRANDS: ReadonlyArray<readonly [brand: RegExp, mime: string]> = [
  [/^(isom|iso2|mp41|mp42|avc1|mp4v|M4V )$/, "video/mp4"],
  [/^M4[AB] $/, "audio/mp4"],
  [/^qt {2}$/, "video/quicktime"],
  [/^3g[p2]/, "video/3gpp"],
];
const ftyp: Sniffer = (header) =>
  header.slice(4, 8) === "ftyp" ? FTYP_BRANDS.find(([brand]) => brand.test(header.slice(8, 12)))?.[1] : undefined;

const SNIFFERS: readonly Sniffer[] = [
  prefixed("audio/ogg", "OggS"),
  riff("WAVE", "audio/wav"),
  (header, bytes) => (header.startsWith("ID3") || mpegFrameSync(bytes) ? "audio/mpeg" : undefined),
  prefixed("image/png", "\x89PNG"),
  prefixed("image/jpeg", "\xff\xd8\xff"),
  prefixed("image/gif", "GIF87a", "GIF89a"),
  riff("WEBP", "image/webp"),
  ftyp,
  ebml("matroska", "video/x-matroska"),
  ebml("webm", "video/webm"),
];

function sniffMime(bytes: Uint8Array): string | undefined {
  const header = String.fromCharCode(...bytes.subarray(0, 64));
  for (const sniff of SNIFFERS) {
    const mime = sniff(header, bytes);
    if (mime !== undefined) return mime;
  }
  return undefined;
}

/** Only files the inbox wrote are readable here, so a part ref cannot name an arbitrary machine path. */
function inboxLocus(ref: string, files: FilePorts, root: string) {
  const machine = defaultMachineOf(files);
  const parsed = Result.try({ try: () => parseLocus(ref, { defaultMachine: machine }), catch: CauseText.parse });
  if (Result.isFailure(parsed)) return undefined;
  const locus = parsed.success;
  return locus.machine === machine && locus.path.startsWith(`${root}/`) ? locus : undefined;
}

export function inboxPartBytes(files: FilePorts, root: string): PartBytes<PartUnreadable> {
  return (ref) => {
    const locus = inboxLocus(ref, files, root);
    if (locus === undefined)
      return Effect.fail(new PartUnreadable({ code: "not_inbox", ref, detail: `not under ${root}` }));
    return Effect.tryPromise({
      try: async () => {
        const file = filesystem(`${locus.machine}:${locus.path}`, files);
        const size = await file.size();
        if (size > MEDIA_BYTE_CAP)
          throw new PartUnreadable({ code: "too_large", ref, detail: `${size} exceeds ${MEDIA_BYTE_CAP} bytes` });
        const bytes = new Uint8Array(await file.read());
        return { bytes, mime: sniffMime(bytes) ?? mediaMime(basename(locus.path)) };
      },
      catch: unreadable(ref),
    });
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

type ExecOutcome =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly detail: string };

/** A shell answers 127 for a command it cannot find, which is how an absent ffmpeg shows on the machine. */
function exec(machines: Machines, machine: string, cmd: string, cwd: string): Effect.Effect<ExecOutcome> {
  return Effect.promise(() => machines.get(machine).exec(cmd, cwd).then(
    (result): ExecOutcome => {
      if (result.status !== "completed")
        return { kind: "failed", detail: result.status === "refused" ? result.reason : result.status };
      if (result.exitCode === 127) return { kind: "missing" };
      if (result.exitCode !== 0)
        return { kind: "failed", detail: `exit ${result.exitCode}: ${new TextDecoder().decode(result.stderr).trim()}` };
      return { kind: "ok", stdout: new TextDecoder().decode(result.stdout) };
    },
    (error: Error): ExecOutcome => ({ kind: "failed", detail: String(error) }),
  ));
}

function durationText(ms: number | undefined): string {
  return ms === undefined ? "unknown duration" : `${Math.round(ms / 1000)}s`;
}

export interface MediaInputPorts {
  readonly files: FilePorts;
  readonly root: string;
  readonly stt: Stt;
  readonly warn: (warning: MediaWarning) => void;
}

const NOTHING: DerivedPart = { parts: [] };

/** Candidates share expensive derivatives, but only a candidate that reads images starts extraction. */
export function mediaDerive(ports: MediaInputPorts): PartDerive {
  const machines = ports.files.machines;
  const bytes = inboxPartBytes(ports.files, ports.root);
  const cached = new Map<string, Effect.Effect<DerivedPart>>();
  let ffmpegWarned = false;
  const warnMissing = (ref: string) => {
    if (ffmpegWarned) return;
    ffmpegWarned = true;
    ports.warn({ code: "ffmpeg_missing", ref, detail: "ffmpeg is not on the attached machine; video kept as its duration line" });
  };

  const transcript = (attachment: Attachment): Effect.Effect<DerivedPart> =>
    bytes(attachment.ref).pipe(
      Effect.flatMap((audio) => ports.stt.transcribe({ bytes: audio.bytes })),
      Effect.map((result): DerivedPart => ({ text: `[voice transcript]\n${result.text}`, parts: [] })),
      Effect.catch((error: Error) => Effect.sync((): DerivedPart => {
        ports.warn({ code: "transcript_failed", ref: attachment.ref, detail: String(error) });
        return NOTHING;
      })),
    );

  const probe = (host: Machines, machine: string, path: string): Effect.Effect<number | "missing" | undefined> =>
    exec(host, machine, `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${quote(path)}`, ports.root).pipe(
      Effect.map((outcome) => {
        if (outcome.kind === "missing") return "missing";
        const seconds = outcome.kind === "ok" ? Number.parseFloat(outcome.stdout) : Number.NaN;
        return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
      }),
    );

  const frames = (attachment: Attachment): Effect.Effect<DerivedPart> => Effect.gen(function* () {
    const locus = inboxLocus(attachment.ref, ports.files, ports.root);
    if (locus === undefined || machines === undefined)
      return { text: `[video ${durationText(attachment.durationMs)}, 0 frames]`, parts: [] };
    const probed = attachment.durationMs ?? (yield* probe(machines, locus.machine, locus.path));
    if (probed === "missing") {
      warnMissing(attachment.ref);
      return { text: `[video ${durationText(undefined)}, 0 frames]`, parts: [] };
    }
    const every = Math.max(1, Math.ceil((probed ?? 0) / 1000 / MAX_FRAMES));
    const dir = `${locus.path}.frames`;
    const cut = yield* exec(machines, locus.machine, [
      `mkdir -p ${quote(dir)} &&`,
      `ffmpeg -nostdin -v error -y -i ${quote(locus.path)} -vf fps=1/${every} -frames:v ${MAX_FRAMES} ${quote(`${dir}/frame-%02d.jpg`)}`,
    ].join(" "), ports.root);
    const line = (count: number) => `[video ${durationText(probed)}, ${count} frames]`;
    if (cut.kind === "missing") warnMissing(attachment.ref);
    if (cut.kind === "failed") ports.warn({ code: "frames_failed", ref: attachment.ref, detail: cut.detail });
    if (cut.kind !== "ok") return { text: line(0), parts: [] };
    const listed = yield* Effect.promise(() => filesystem(`${locus.machine}:${dir}`, ports.files).list().then(
      (entries) => entries.filter((entry) => entry.kind === "file" && /^frame-\d+\.jpg$/.test(entry.name)).map((entry) => entry.name).sort(),
      (error: Error) => {
        ports.warn({ code: "frames_failed", ref: attachment.ref, detail: String(error) });
        return [];
      },
    ));
    const cutFrames = listed.slice(0, MAX_FRAMES).map((name): Attachment => ({
      kind: "image", ref: `${locus.machine}:${dir}/${name}`, name, mime: "image/jpeg",
    }));
    return { text: line(cutFrames.length), parts: cutFrames };
  });

  return (attachment, model: Capability.InputModel) => Effect.gen(function* () {
    if (attachment.mime !== undefined && Capability.accepts(model, attachment)) return NOTHING;
    if (attachment.kind !== "audio" && attachment.kind !== "video") return NOTHING;
    const existing = cached.get(attachment.ref);
    if (existing !== undefined) return yield* existing;
    if (attachment.kind === "video" && !Capability.accepts(model, "image")) {
      return { text: `[video ${durationText(attachment.durationMs)}, 0 frames]`, parts: [] };
    }
    const derived = yield* Effect.cached(attachment.kind === "audio" ? transcript(attachment) : frames(attachment));
    cached.set(attachment.ref, derived);
    return yield* derived;
  });
}
