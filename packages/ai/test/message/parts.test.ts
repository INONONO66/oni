import { describe, expect, test } from "bun:test";
import type { Gateway } from "@oni/protocol";
import { Effect } from "effect";
import { type PartBytes, resolveInputParts } from "../../src";
import type { Provider } from "../../src/provider";
import { runTestSync } from "../helpers/runner";

const vision: Provider.Model = { id: "claude-sonnet-4-5", providerID: "anthropic", name: "Sonnet", input: ["text", "image"], api: { npm: "@ai-sdk/anthropic" } };
const audio: Provider.Model = { id: "audio", providerID: "openai", name: "Audio", input: ["text", "image", "audio", "video"], api: { npm: "@ai-sdk/openai", style: "chat" } };
const textOnly: Provider.Model = { id: "o3-mini", providerID: "openai", name: "o3-mini" };
const gemini: Provider.Model = { id: "gemini-2.5-flash", providerID: "google", name: "Gemini", input: ["text", "image", "audio", "video"], api: { npm: "@ai-sdk/google" } };

const photo: Gateway.MediaPart = { kind: "image", ref: "mac:/p.png", mime: "image/png" };
const voice: Gateway.MediaPart = { kind: "audio", ref: "mac:/voice", name: "voice", voice: true, mime: "audio/wav" };
const doc: Gateway.MediaPart = { kind: "file", ref: "mac:/d.pdf" };
const lost: Gateway.MediaPart = { kind: "image", ref: "mac:/gone.png" };
const png = new Uint8Array([137, 80, 78, 71]);
const wav = new Uint8Array([1, 2, 3]);
const pdf = new Uint8Array([37, 80, 68, 70]);
const bytes: PartBytes<string> = (ref) => {
  if (ref === photo.ref) return Effect.succeed({ bytes: png, mime: "image/jpeg" });
  if (ref === voice.ref) return Effect.succeed({ bytes: wav, mime: "application/octet-stream" });
  if (ref === doc.ref) return Effect.succeed({ bytes: pdf, mime: "application/pdf" });
  return Effect.fail(`no bytes for ${ref}`);
};

describe("resolveInputParts", () => {
  test("declared MIME wins over the extension-derived byte source MIME", () => {
    expect(runTestSync(resolveInputParts({ parts: [photo, voice], model: audio, bytes }))).toEqual({
      unaccepted: [],
      blocks: [
        { type: "image", image: png, mediaType: "image/png" },
        { type: "file", data: wav, mediaType: "audio/wav", filename: "voice" },
      ],
    });
  });

  test("missing MIME uses the resolved MIME, with optional filenames omitted", () => {
    expect(runTestSync(resolveInputParts({
      parts: [{ kind: "audio", ref: "voice" }], model: audio,
      bytes: () => Effect.succeed({ bytes: wav, mime: "audio/mpeg" }),
    }))).toEqual({ unaccepted: [], blocks: [{ type: "file", data: wav, mediaType: "audio/mpeg" }] });
  });

  test("unsupported resolved MIME is a modality miss", () => {
    const part: Gateway.MediaPart = { kind: "audio", ref: "voice" };
    expect(runTestSync(resolveInputParts({
      parts: [part], model: audio, bytes: () => Effect.succeed({ bytes: wav, mime: "audio/ogg" }),
    }))).toEqual({ blocks: [], unaccepted: [{ part, reason: "modality" }] });
  });

  test("unreadable kinds and unresolved bytes retain distinct causes", () => {
    expect(runTestSync(resolveInputParts({ parts: [photo, voice, doc, lost], model: vision, bytes }))).toEqual({
      blocks: [{ type: "image", image: png, mediaType: "image/png" }],
      unaccepted: [
        { part: voice, reason: "modality" },
        { part: doc, reason: "modality" },
        { part: lost, reason: "unresolved", cause: "no bytes for mac:/gone.png" },
      ],
    });
  });

  test("a PDF reaches a google model as a file block; a text-only model with the same bytes refuses it", () => {
    expect(runTestSync(resolveInputParts({ parts: [doc], model: gemini, bytes }))).toEqual({
      blocks: [{ type: "file", data: pdf, mediaType: "application/pdf" }],
      unaccepted: [],
    });
    expect(runTestSync(resolveInputParts({ parts: [doc], model: textOnly, bytes: () => Effect.die(new Error("must not read")) })))
      .toEqual({ blocks: [], unaccepted: [{ part: doc, reason: "modality" }] });
  });

  test("a text-only model never reads media bytes", () => {
    expect(runTestSync(resolveInputParts({
      parts: [photo], model: textOnly, bytes: () => Effect.die(new Error("must not read")),
    }))).toEqual({ blocks: [], unaccepted: [{ part: photo, reason: "modality" }] });
  });

  test("refused parts derive once and retain unreadable replacements without recursive derivation", () => {
    const derived: string[] = [];
    const result = runTestSync(resolveInputParts({
      parts: [voice, photo, lost], model: vision, bytes,
      derive: (part, model) => Effect.sync(() => {
        expect(model).toBe(vision);
        derived.push(part.ref);
        return { text: "transcript", parts: [photo, voice, lost] };
      }),
    }));
    expect(derived).toEqual([voice.ref]);
    expect(result).toEqual({
      blocks: [
        { type: "image", image: png, mediaType: "image/png" },
        { type: "text", text: "transcript" },
        { type: "image", image: png, mediaType: "image/png" },
      ],
      unaccepted: [
        { part: voice, reason: "modality" },
        { part: lost, reason: "unresolved", cause: "no bytes for mac:/gone.png" },
        { part: lost, reason: "unresolved", cause: "no bytes for mac:/gone.png" },
      ],
    });
  });

  test("source format refusal invokes derivation and retains unreadable replacements", () => {
    const source: Gateway.MediaPart = { kind: "audio", ref: "source" };
    const derived: string[] = [];
    expect(runTestSync(resolveInputParts({
      parts: [source], model: audio,
      bytes: () => Effect.succeed({ bytes: wav, mime: "audio/ogg" }),
      derive: (part) => Effect.sync(() => {
        derived.push(part.ref);
        return { parts: [{ kind: "audio", ref: "replacement" }] };
      }),
    }))).toEqual({
      blocks: [],
      unaccepted: [{ part: { kind: "audio", ref: "replacement" }, reason: "modality" }],
    });
    expect(derived).toEqual(["source"]);
  });
});
