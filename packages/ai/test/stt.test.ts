import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { Auth, makeStt, ProviderRow } from "../src";
import { runEffect } from "./helpers/native";
import { collector } from "./helpers/observation";
import { jsonResponse, mockFetch } from "./helpers/provider-fetch";
import { runTestExit } from "./helpers/runner";

const original = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = original;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function authFile(...providers: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "oni-stt-"));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  for (const provider of ["openai", ...providers]) {
    const written = await runTestExit(Auth.set(provider, { type: "api", key: `sk-${provider}` }, { id: () => provider, authFilePath: path }));
    expect(Exit.isSuccess(written)).toBe(true);
  }
  return path;
}

const audio = { bytes: new Uint8Array([79, 103, 103, 83, 17, 204, 5]), traceId: "trace-stt-1" };

/** A clock that advances 40ms per read, so every call's duration is exact. */
function ticking(): () => number {
  let tick = 1_000;
  return () => {
    tick += 40;
    return tick;
  };
}

type SttInput = Parameters<typeof makeStt>[0];
function stt(input: Omit<SttInput, "events" | "now"> & Partial<Pick<SttInput, "events" | "now">>) {
  return makeStt({ events: collector(), now: ticking(), ...input });
}

const openai = ProviderRow.parse({ id: "openai", npm: "@ai-sdk/openai", transcription: "whisper-1" });

describe("Stt", () => {
  test("transcribes through the first row that names a transcription model", async () => {
    const requests: { url: string; model: string | File | null }[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const form = init?.body instanceof FormData ? init.body : undefined;
      const file = form?.get("file");
      expect(file).toBeInstanceOf(File);
      if (!(file instanceof File)) throw new Error("transcription file missing");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio.bytes);
      requests.push({ url: String(input), model: form?.get("model") ?? null });
      return jsonResponse({ text: "hello there", language: "english", duration: 1.25 });
    });
    const exit = await runTestExit(stt({ authFilePath: await authFile(), transport: { baseUrl: "https://stt.test/v1" } }).transcribe(audio));
    expect(exit).toEqual(Exit.succeed({ text: "hello there", language: "en", durationMs: 1250 }));
    expect(requests).toEqual([{ url: "https://stt.test/v1/audio/transcriptions", model: "gpt-4o-transcribe" }]);
  });

  test("an explicit model picks its provider row and id over the first transcription row", async () => {
    const models: (string | File | null)[] = [];
    globalThis.fetch = mockFetch(async (_input, init) => {
      models.push(init?.body instanceof FormData ? init.body.get("model") : null);
      return jsonResponse({ text: "ok" });
    });
    const gateway = ProviderRow.parse({ id: "gateway", npm: "@ai-sdk/openai" });
    const explicit = stt({ authFilePath: await authFile("gateway"), rows: [openai, gateway], model: { provider: "gateway", id: "gw-transcribe" } });
    expect(await runTestExit(explicit.transcribe(audio))).toEqual(Exit.succeed({ text: "ok" }));
    expect(models).toEqual(["gw-transcribe"]);
  });

  test("an explicit model refuses typed when its row is absent or lacks the transcription surface", async () => {
    const authFilePath = await authFile("anthropic");
    const absent = await runEffect(Effect.flip(stt({ authFilePath, rows: [openai], model: { provider: "gateway", id: "gw-1" } }).transcribe(audio)));
    expect(absent).toMatchObject({ _tag: "ModelResolutionError", reason: "provider_not_found", provider: "gateway", model: "gw-1" });
    const anthropic = ProviderRow.parse({ id: "anthropic", npm: "@ai-sdk/anthropic" });
    const noSurface = await runEffect(Effect.flip(stt({ authFilePath, rows: [openai, anthropic], model: { provider: "anthropic", id: "claude" } }).transcribe(audio)));
    expect(noSurface).toMatchObject({ _tag: "ModelResolutionError", reason: "model_not_found", provider: "anthropic", model: "claude" });
  });

  test("every settled call publishes one llm.transcription.completed row", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse({ text: "ok" }));
    const events = collector();
    const observed = stt({ authFilePath: await authFile(), rows: [openai], events, now: ticking() });
    expect(await runTestExit(observed.transcribe(audio))).toEqual(Exit.succeed({ text: "ok" }));
    expect(await runTestExit(observed.transcribe({ bytes: new Uint8Array(3), traceId: "trace-stt-2" }))).toEqual(Exit.succeed({ text: "ok" }));
    expect(events.events.map((event) => event.name)).toEqual(["llm.transcription.completed", "llm.transcription.completed"]);
    expect(events.named("llm.transcription.completed")).toEqual([
      { traceId: "trace-stt-1", time: 1_080, provider: "openai", model: "whisper-1", inputBytes: 7, durationMs: 40 },
      { traceId: "trace-stt-2", time: 1_160, provider: "openai", model: "whisper-1", inputBytes: 3, durationMs: 40 },
    ]);
  });

  test("a failed provider call publishes exactly one llm.transcription.failed row", async () => {
    globalThis.fetch = mockFetch(() => new Response("{\"error\":{\"message\":\"down\"}}", { status: 500 }));
    const events = collector();
    const failed = await runTestExit(stt({ authFilePath: await authFile(), rows: [openai], events, now: ticking() }).transcribe(audio));
    expect(Exit.isFailure(failed)).toBe(true);
    expect(events.events.map((event) => event.name)).toEqual(["llm.transcription.failed"]);
    const [row] = events.named("llm.transcription.failed");
    expect(row).toEqual({ traceId: "trace-stt-1", time: 1_080, provider: "openai", model: "whisper-1", inputBytes: 7, durationMs: 40, error: expect.any(String) });
  });

  test("the model id comes from the row, not the code", async () => {
    const models: (string | File | null)[] = [];
    globalThis.fetch = mockFetch(async (_input, init) => {
      models.push(init?.body instanceof FormData ? init.body.get("model") : null);
      return jsonResponse({ text: "ok" });
    });
    const exit = await runTestExit(stt({ authFilePath: await authFile(), rows: [openai] }).transcribe(audio));
    expect(exit).toEqual(Exit.succeed({ text: "ok" }));
    expect(models).toEqual(["whisper-1"]);
  });

  test("no transcription row, a provider without the surface, missing auth and a provider failure are typed", async () => {
    globalThis.fetch = mockFetch(() => new Response("{\"error\":{\"message\":\"down\"}}", { status: 500 }));
    const authFilePath = await authFile();
    const noRow = await runTestExit(stt({ authFilePath, rows: [ProviderRow.parse({ id: "openai", npm: "@ai-sdk/openai" })] }).transcribe(audio));
    expect(Exit.isFailure(noRow) && JSON.stringify(noRow.cause)).toContain("No provider row names a transcription model");
    const anthropic = ProviderRow.parse({ id: "openai", npm: "@ai-sdk/anthropic", transcription: "x" });
    const noSurface = await runTestExit(stt({ authFilePath, rows: [anthropic] }).transcribe(audio));
    expect(Exit.isFailure(noSurface) && JSON.stringify(noSurface.cause)).toContain("has no transcription surface");
    const noAuth = await runTestExit(stt({ authFilePath: join(dirs[0] ?? "", "absent.json") }).transcribe(audio));
    expect(Exit.isFailure(noAuth) && JSON.stringify(noAuth.cause)).toContain("missing_auth");
    const failed = await runTestExit(stt({ authFilePath }).transcribe(audio));
    expect(Exit.isFailure(failed) && JSON.stringify(failed.cause)).toContain("APIError");
  });
});
