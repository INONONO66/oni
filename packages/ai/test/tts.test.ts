import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { Auth, makeTts, ProviderRow } from "../src";
import { runEffect } from "./helpers/native";
import { collector } from "./helpers/observation";
import { mockFetch } from "./helpers/provider-fetch";
import { runTestExit } from "./helpers/runner";

const original = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = original;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function authFile(...providers: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "oni-tts-"));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  for (const provider of ["openai", ...providers]) {
    const written = await runTestExit(Auth.set(provider, { type: "api", key: `sk-${provider}` }, { id: () => provider, authFilePath: path }));
    expect(Exit.isSuccess(written)).toBe(true);
  }
  return path;
}

const mp3 = new Uint8Array([255, 251, 144, 68, 0, 0, 0]);
const ogg = new Uint8Array([79, 103, 103, 83, 17, 204, 5, 9]);
const call = { text: "hello there", traceId: "trace-tts-1" };

function audioResponse(bytes: Uint8Array<ArrayBuffer>): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
}

interface SpeechRequest {
  readonly url: string;
  readonly body: Record<string, string>;
}

function recording(responses: () => Response): { requests: SpeechRequest[] } {
  const requests: SpeechRequest[] = [];
  globalThis.fetch = mockFetch((input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return responses();
  });
  return { requests };
}

/** A clock that advances 40ms per read, so every call's duration is exact. */
function ticking(): () => number {
  let tick = 1_000;
  return () => {
    tick += 40;
    return tick;
  };
}

type TtsInput = Parameters<typeof makeTts>[0];
function tts(input: Omit<TtsInput, "events" | "now"> & Partial<Pick<TtsInput, "events" | "now">>) {
  return makeTts({ events: collector(), now: ticking(), ...input });
}

const openai = ProviderRow.parse({ id: "openai", npm: "@ai-sdk/openai", speech: { model: "gpt-4o-mini-tts", voice: "alloy" } });

describe("Tts", () => {
  test("speaks through the first row that names a speech model and returns the audio with its media type", async () => {
    const { requests } = recording(() => audioResponse(mp3));
    const exit = await runTestExit(tts({ authFilePath: await authFile(), rows: [openai], transport: { baseUrl: "https://tts.test/v1" } }).speak(call));
    expect(exit).toEqual(Exit.succeed({ bytes: mp3, mediaType: "audio/mpeg" }));
    expect(requests).toEqual([{ url: "https://tts.test/v1/audio/speech", body: { model: "gpt-4o-mini-tts", input: "hello there", voice: "alloy", response_format: "mp3" } }]);
  });

  test("the row's voice, format and model are the defaults; a call overrides each", async () => {
    const { requests } = recording(() => audioResponse(ogg));
    const wav = ProviderRow.parse({ id: "openai", npm: "@ai-sdk/openai", speech: { model: "tts-1", voice: "nova", format: "wav" } });
    const port = tts({ authFilePath: await authFile(), rows: [wav] });
    expect(await runTestExit(port.speak(call))).toEqual(Exit.succeed({ bytes: ogg, mediaType: "audio/ogg" }));
    expect(await runTestExit(port.speak({ ...call, voice: "echo", format: "opus" }))).toEqual(Exit.succeed({ bytes: ogg, mediaType: "audio/ogg" }));
    expect(await runTestExit(port.speak({ ...call, model: "tts-1-hd" }))).toEqual(Exit.succeed({ bytes: ogg, mediaType: "audio/ogg" }));
    expect(requests.map((request) => request.body)).toEqual([
      { model: "tts-1", input: "hello there", voice: "nova", response_format: "wav" },
      { model: "tts-1", input: "hello there", voice: "echo", response_format: "opus" },
      { model: "tts-1-hd", input: "hello there", voice: "nova", response_format: "wav" },
    ]);
  });

  test("the first row naming a speech model serves the call, skipping rows without one", async () => {
    const { requests } = recording(() => audioResponse(mp3));
    const voiceless = ProviderRow.parse({ id: "gateway", npm: "@ai-sdk/openai" });
    const first = tts({ authFilePath: await authFile("gateway"), rows: [voiceless, openai] });
    expect(await runTestExit(first.speak(call))).toEqual(Exit.succeed({ bytes: mp3, mediaType: "audio/mpeg" }));
    expect(requests.map((request) => request.body)).toEqual([{ model: "gpt-4o-mini-tts", input: "hello there", voice: "alloy", response_format: "mp3" }]);
  });

  test("refuses typed when no row names a speech model, or the first one lacks the speech surface", async () => {
    const authFilePath = await authFile("anthropic", "gateway");
    const voiceless = ProviderRow.parse({ id: "gateway", npm: "@ai-sdk/openai" });
    const none = await runEffect(Effect.flip(tts({ authFilePath, rows: [voiceless] }).speak(call)));
    expect(none).toMatchObject({ _tag: "ModelResolutionError", reason: "model_not_found", provider: "", model: "" });
    const anthropic = ProviderRow.parse({ id: "anthropic", npm: "@ai-sdk/anthropic", speech: { model: "claude", voice: "x" } });
    const noSurface = await runEffect(Effect.flip(tts({ authFilePath, rows: [anthropic, openai] }).speak(call)));
    expect(noSurface).toMatchObject({ _tag: "ModelResolutionError", reason: "model_not_found", provider: "anthropic", model: "claude" });
  });

  test("every settled call publishes one llm.speech.completed row sized by text and audio", async () => {
    recording(() => audioResponse(mp3));
    const events = collector();
    const observed = tts({ authFilePath: await authFile(), rows: [openai], events, now: ticking() });
    expect(Exit.isSuccess(await runTestExit(observed.speak(call)))).toBe(true);
    expect(Exit.isSuccess(await runTestExit(observed.speak({ text: "bye", traceId: "trace-tts-2" })))).toBe(true);
    expect(events.events.map((event) => event.name)).toEqual(["llm.speech.completed", "llm.speech.completed"]);
    expect(events.named("llm.speech.completed")).toEqual([
      { traceId: "trace-tts-1", time: 1_080, provider: "openai", model: "gpt-4o-mini-tts", inputChars: 11, outputBytes: 7, durationMs: 40 },
      { traceId: "trace-tts-2", time: 1_160, provider: "openai", model: "gpt-4o-mini-tts", inputChars: 3, outputBytes: 7, durationMs: 40 },
    ]);
  });

  test("a failed provider call publishes exactly one llm.speech.failed row", async () => {
    globalThis.fetch = mockFetch(() => new Response("{\"error\":{\"message\":\"down\"}}", { status: 500 }));
    const events = collector();
    const failed = await runTestExit(tts({ authFilePath: await authFile(), rows: [openai], events, now: ticking() }).speak(call));
    expect(Exit.isFailure(failed) && JSON.stringify(failed.cause)).toContain("APIError");
    expect(events.events.map((event) => event.name)).toEqual(["llm.speech.failed"]);
    const [row] = events.named("llm.speech.failed");
    expect(row).toEqual({ traceId: "trace-tts-1", time: 1_080, provider: "openai", model: "gpt-4o-mini-tts", inputChars: 11, durationMs: 40, error: expect.any(String) });
  });

  test("no speech row, a provider without the surface and missing auth are typed", async () => {
    recording(() => audioResponse(mp3));
    const authFilePath = await authFile();
    const noRow = await runTestExit(tts({ authFilePath, rows: [ProviderRow.parse({ id: "openai", npm: "@ai-sdk/openai" })] }).speak(call));
    expect(Exit.isFailure(noRow) && JSON.stringify(noRow.cause)).toContain("No provider row names a speech model");
    const anthropic = ProviderRow.parse({ id: "openai", npm: "@ai-sdk/anthropic", speech: { model: "x", voice: "y" } });
    const noSurface = await runTestExit(tts({ authFilePath, rows: [anthropic] }).speak(call));
    expect(Exit.isFailure(noSurface) && JSON.stringify(noSurface.cause)).toContain("has no speech surface");
    const noAuth = await runTestExit(tts({ authFilePath: join(dirs[0] ?? "", "absent.json"), rows: [openai] }).speak(call));
    expect(Exit.isFailure(noAuth) && JSON.stringify(noAuth.cause)).toContain("missing_auth");
  });
});
