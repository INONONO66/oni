import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImage, generateSpeech } from "ai";
import { Exit } from "effect";
import { Auth, makeStt } from "../../src";
import { Provider } from "../../src/provider";
import { BUNDLED_ROWS } from "../../src/provider/rows";
import { getLanguage, getSDK } from "../../src/provider/sdk";
import { collector } from "../helpers/observation";
import { jsonResponse, mockFetch } from "../helpers/provider-fetch";
import { runTestExit } from "../helpers/runner";

const originalFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const row = BUNDLED_ROWS.find((candidate) => candidate.id === "google");
if (row?.image === undefined || row.speech === undefined) throw new Error("bundled google row is missing a surface");
const { image, speech } = row;
const auth = { type: "api", key: "gk-test" } as const;
const base = "https://generativelanguage.googleapis.com/v1beta";

function model(id: string): Provider.Model {
  return Provider.withRow({ id, providerID: "google", name: id }, row);
}

type Captured = { url: string; headers: Headers; body: string };
function capture(response: Parameters<typeof jsonResponse>[0]): Captured[] {
  const requests: Captured[] = [];
  globalThis.fetch = mockFetch((input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
    return jsonResponse(response);
  });
  return requests;
}

function inline(mimeType: string, bytes: Uint8Array) {
  const data = Buffer.from(bytes).toString("base64");
  return { candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType, data } }] }, finishReason: "STOP" }] };
}

async function authFile(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "oni-google-"));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  expect(Exit.isSuccess(await runTestExit(Auth.set("google", auth, { id: () => "google", authFilePath: path })))).toBe(true);
  return path;
}

describe("google provider row", () => {
  test("a chat turn posts generateContent for the model with the key header", async () => {
    const requests = capture({
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });
    const result = await getLanguage(model("gemini-2.5-flash"), auth).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(result.content).toMatchObject([{ type: "text", text: "ok" }]);
    expect(requests.map((request) => request.url)).toEqual([`${base}/models/gemini-2.5-flash:generateContent`]);
    expect(requests[0]?.headers.get("x-goog-api-key")).toBe("gk-test");
  });

  test("one image call through the row's image model returns the inline image bytes", async () => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const requests = capture(inline("image/png", png));
    const sdk = getSDK(model(image.model), auth);
    if (!("image" in sdk)) throw new Error("google SDK has no image surface");
    const generated = await generateImage({ model: sdk.image(image.model), prompt: "a cat", maxRetries: 0 });
    expect(generated.image.mediaType).toBe("image/png");
    expect(generated.image.uint8Array).toEqual(png);
    expect(requests.map((request) => request.url)).toEqual([`${base}/models/${image.model}:generateContent`]);
    expect(JSON.parse(requests[0]?.body ?? "")).toMatchObject({ contents: [{ role: "user", parts: [{ text: "a cat" }] }] });
  });

  test("one speech call through the row's speech model wraps the PCM answer in the row's WAV container", async () => {
    const pcm = Uint8Array.from([1, 0, 2, 0, 3, 0]);
    const requests = capture(inline("audio/L16;codec=pcm;rate=24000", pcm));
    const sdk = getSDK(model(speech.model), auth);
    if (!("speech" in sdk)) throw new Error("google SDK has no speech surface");
    const generated = await generateSpeech({
      model: sdk.speech(speech.model), text: "hello", voice: speech.voice, outputFormat: speech.format, maxRetries: 0,
    });
    expect(generated.audio.mediaType).toBe("audio/wav");
    expect(generated.audio.uint8Array.byteLength).toBe(44 + pcm.byteLength);
    expect(generated.audio.uint8Array.slice(44)).toEqual(pcm);
    expect(requests.map((request) => request.url)).toEqual([`${base}/models/${speech.model}:generateContent`]);
    expect(JSON.parse(requests[0]?.body ?? "")).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
    });
  });

  test("transcription through the row posts the interactions request and reads the text steps", async () => {
    const requests = capture({ status: "completed", steps: [{ type: "model_generation", content: [{ type: "text", text: "hello there" }] }] });
    const bytes = Uint8Array.from([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69]);
    const stt = makeStt({ authFilePath: await authFile(), rows: [row], events: collector(), now: () => 1_000 });
    expect(await runTestExit(stt.transcribe({ bytes, traceId: "trace-google-1" }))).toEqual(Exit.succeed({ text: "hello there" }));
    expect(requests.map((request) => request.url)).toEqual([`${base}/interactions`]);
    expect(JSON.parse(requests[0]?.body ?? "")).toMatchObject({
      model: row.transcription, input: [{ type: "audio", data: Buffer.from(bytes).toString("base64"), mime_type: "audio/wav" }],
    });
  });
});
