import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Exit } from "effect";
import { Auth, makeStt, ProviderRow } from "../src";
import { jsonResponse, mockFetch } from "./helpers/provider-fetch";
import { runTestExit } from "./helpers/runner";

const original = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = original;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function authFile(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "oni-stt-"));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  const written = await runTestExit(Auth.set("openai", { type: "api", key: "sk-stt" }, { id: () => "stt", authFilePath: path }));
  expect(Exit.isSuccess(written)).toBe(true);
  return path;
}

const audio = { bytes: new Uint8Array([79, 103, 103, 83]) };

describe("Stt", () => {
  test("transcribes through the first row that names a transcription model", async () => {
    const requests: { url: string; model: string | File | null }[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const form = init?.body instanceof FormData ? init.body : undefined;
      requests.push({ url: String(input), model: form?.get("model") ?? null });
      return jsonResponse({ text: "hello there", language: "english", duration: 1.25 });
    });
    const stt = makeStt({ authFilePath: await authFile(), transport: { baseUrl: "https://stt.test/v1" } });
    const exit = await runTestExit(stt.transcribe(audio));
    expect(exit).toEqual(Exit.succeed({ text: "hello there", language: "en", durationMs: 1250 }));
    expect(requests).toEqual([{ url: "https://stt.test/v1/audio/transcriptions", model: "gpt-4o-transcribe" }]);
  });

  test("the model id comes from the row, not the code", async () => {
    const models: (string | File | null)[] = [];
    globalThis.fetch = mockFetch(async (_input, init) => {
      models.push(init?.body instanceof FormData ? init.body.get("model") : null);
      return jsonResponse({ text: "ok" });
    });
    const rows = [ProviderRow.parse({ id: "openai", npm: "@ai-sdk/openai", transcription: "whisper-1" })];
    const exit = await runTestExit(makeStt({ authFilePath: await authFile(), rows }).transcribe(audio));
    expect(exit).toEqual(Exit.succeed({ text: "ok" }));
    expect(models).toEqual(["whisper-1"]);
  });

  test("no transcription row, a provider without the surface, missing auth and a provider failure are typed", async () => {
    globalThis.fetch = mockFetch(() => new Response("{\"error\":{\"message\":\"down\"}}", { status: 500 }));
    const authFilePath = await authFile();
    const noRow = await runTestExit(makeStt({ authFilePath, rows: [ProviderRow.parse({ id: "openai", npm: "@ai-sdk/openai" })] }).transcribe(audio));
    expect(Exit.isFailure(noRow) && JSON.stringify(noRow.cause)).toContain("No provider row names a transcription model");
    const anthropic = ProviderRow.parse({ id: "openai", npm: "@ai-sdk/anthropic", transcription: "x" });
    const noSurface = await runTestExit(makeStt({ authFilePath, rows: [anthropic] }).transcribe(audio));
    expect(Exit.isFailure(noSurface) && JSON.stringify(noSurface.cause)).toContain("has no transcription surface");
    const noAuth = await runTestExit(makeStt({ authFilePath: join(dirs[0] ?? "", "absent.json") }).transcribe(audio));
    expect(Exit.isFailure(noAuth) && JSON.stringify(noAuth.cause)).toContain("missing_auth");
    const failed = await runTestExit(makeStt({ authFilePath }).transcribe(audio));
    expect(Exit.isFailure(failed) && JSON.stringify(failed.cause)).toContain("APIError");
  });
});
