import type { Modality } from "./schema";

type Transport = Partial<Record<Modality | "file", readonly string[]>>;

const images = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const imageTransport: Transport = { image: images };
const transports = new Map<string, Transport>([
  ["@ai-sdk/anthropic", imageTransport],
  [
    "@ai-sdk/google",
    {
      image: ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"],
      audio: [
        "audio/aac", "audio/aiff", "audio/alaw", "audio/flac", "audio/l16", "audio/m4a", "audio/mp3", "audio/mp4",
        "audio/mpeg", "audio/mpga", "audio/mulaw", "audio/ogg", "audio/opus", "audio/pcm", "audio/wav", "audio/webm",
      ],
      video: [
        "video/3gpp", "video/avi", "video/mov", "video/mp4", "video/mpeg", "video/mpegps", "video/mpg",
        "video/quicktime", "video/webm", "video/wmv", "video/x-flv",
      ],
      file: ["application/pdf"],
    },
  ],
  ["@ai-sdk/openai:chat", { image: images, audio: ["audio/wav", "audio/mpeg", "audio/mp3"] }],
  ["@ai-sdk/openai:responses", imageTransport],
]);

export namespace Capability {
  /** A part kind the caller may hand a model; `file` has no modality row. */
  export type Kind = Modality | "file";

  /** The capability projection of a model: what it reads and the SDK surface the bytes travel on. */
  export type InputModel = {
    readonly input?: readonly Modality[];
    readonly api?: { readonly npm: string; readonly style?: "responses" | "chat" };
  };

  export function accepts(model: InputModel, part: { readonly kind: Kind; readonly mime?: string }): boolean;
  /** Kind-only probes are for callers choosing a degradation path before bytes exist. */
  export function accepts(model: InputModel, kind: Kind): boolean;
  export function accepts(model: InputModel, part: Kind | { readonly kind: Kind; readonly mime?: string }): boolean {
    const { kind, mime } = typeof part === "string" ? { kind: part, mime: undefined } : part;
    if (kind !== "file" && !(model.input ?? ["text"]).includes(kind)) return false;
    if (kind === "text") return true;
    const npm = model.api?.npm ?? "";
    const key = npm === "@ai-sdk/openai" ? `${npm}:${model.api?.style ?? "responses"}` : npm;
    const transport = transports.get(key) ?? imageTransport;
    const formats = transport[kind];
    return formats !== undefined && (mime === undefined || formats.includes(mime));
  }
}
