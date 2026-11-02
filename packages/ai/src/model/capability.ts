import type { Modality } from "./schema";

const images = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const imageTransport: Partial<Record<Modality, readonly string[]>> = { image: images };
const transports = new Map<string, Partial<Record<Modality, readonly string[]>>>([
  ["@ai-sdk/anthropic", imageTransport],
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
    if (kind === "file") return false;
    if (!(model.input ?? ["text"]).includes(kind)) return false;
    if (kind === "text") return true;
    const npm = model.api?.npm ?? "";
    const key = npm === "@ai-sdk/openai" ? `${npm}:${model.api?.style ?? "responses"}` : npm;
    const transport = transports.get(key) ?? imageTransport;
    const formats = transport[kind];
    return formats !== undefined && (mime === undefined || formats.includes(mime));
  }
}
