import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { Auth, makeImage, ProviderRow } from "../src";
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
  const dir = mkdtempSync(join(tmpdir(), "oni-image-"));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  for (const provider of ["openai", ...providers]) {
    const written = await runTestExit(Auth.set(provider, { type: "api", key: `sk-${provider}` }, { id: () => provider, authFilePath: path }));
    expect(Exit.isSuccess(written)).toBe(true);
  }
  return path;
}

/** A PNG signature plus a payload byte: the SDK sniffs the media type from the bytes. */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x02, 0x03]);
const request = { prompt: "a red square", traceId: "trace-image-1" };

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** A clock that advances 40ms per read, so every call's duration is exact. */
function ticking(): () => number {
  let tick = 1_000;
  return () => {
    tick += 40;
    return tick;
  };
}

type ImageInput = Parameters<typeof makeImage>[0];
function image(input: Omit<ImageInput, "events" | "now"> & Partial<Pick<ImageInput, "events" | "now">>) {
  return makeImage({ events: collector(), now: ticking(), ...input });
}

function bodyOf(init: RequestInit | undefined): Record<string, string | number> {
  return JSON.parse(String(init?.body));
}

const openai = ProviderRow.parse({ id: "openai", npm: "@ai-sdk/openai", image: { model: "gpt-image-1" } });

describe("Image", () => {
  test("generates through the first row that names an image model and returns the sniffed bytes", async () => {
    const requests: { url: string; body: Record<string, string | number> }[] = [];
    globalThis.fetch = mockFetch((input, init) => {
      requests.push({ url: String(input), body: bodyOf(init) });
      return jsonResponse({ data: [{ b64_json: b64(png) }, { b64_json: b64(jpeg) }] });
    });
    const exit = await runTestExit(
      image({ authFilePath: await authFile(), transport: { baseUrl: "https://image.test/v1" } }).generate({ ...request, n: 2, size: "1024x1024" }),
    );
    expect(exit).toEqual(Exit.succeed([{ bytes: png, mediaType: "image/png" }, { bytes: jpeg, mediaType: "image/jpeg" }]));
    expect(requests).toEqual([{
      url: "https://image.test/v1/images/generations",
      body: { model: "gpt-image-1", prompt: "a red square", n: 2, size: "1024x1024" },
    }]);
  });

  test("absent n asks for one image and absent size leaves the size to the provider", async () => {
    const bodies: Record<string, string | number>[] = [];
    globalThis.fetch = mockFetch((_input, init) => {
      bodies.push(bodyOf(init));
      return jsonResponse({ data: [{ b64_json: b64(png) }] });
    });
    const exit = await runTestExit(image({ authFilePath: await authFile(), rows: [openai] }).generate(request));
    expect(exit).toEqual(Exit.succeed([{ bytes: png, mediaType: "image/png" }]));
    expect(bodies).toEqual([{ model: "gpt-image-1", prompt: "a red square", n: 1 }]);
  });

  test("an explicit model id stays on the first image row, skipping rows without one", async () => {
    const bodies: Record<string, string | number>[] = [];
    globalThis.fetch = mockFetch((_input, init) => {
      bodies.push(bodyOf(init));
      return jsonResponse({ data: [{ b64_json: b64(png) }] });
    });
    const imageless = ProviderRow.parse({ id: "gateway", npm: "@ai-sdk/openai" });
    const explicit = image({ authFilePath: await authFile("gateway"), rows: [imageless, openai] });
    const exit = await runTestExit(explicit.generate({ ...request, model: "dall-e-3" }));
    expect(exit).toEqual(Exit.succeed([{ bytes: png, mediaType: "image/png" }]));
    expect(bodies).toEqual([{ model: "dall-e-3", prompt: "a red square", n: 1, response_format: "b64_json" }]);
  });

  test("an explicit model picks its provider row and id over the first image row", async () => {
    const bodies: Record<string, string | number>[] = [];
    globalThis.fetch = mockFetch((_input, init) => {
      bodies.push(bodyOf(init));
      return jsonResponse({ data: [{ b64_json: b64(png) }] });
    });
    const gateway = ProviderRow.parse({ id: "gateway", npm: "@ai-sdk/openai" });
    const explicit = image({ authFilePath: await authFile("gateway"), rows: [openai, gateway], model: { provider: "gateway", id: "gw-image" } });
    expect(await runTestExit(explicit.generate(request))).toEqual(Exit.succeed([{ bytes: png, mediaType: "image/png" }]));
    expect(bodies).toEqual([{ model: "gw-image", prompt: "a red square", n: 1, response_format: "b64_json" }]);
  });

  test("an explicit model refuses typed when its provider row is absent", async () => {
    const absent = await runEffect(Effect.flip(image({ authFilePath: await authFile(), rows: [openai], model: { provider: "gateway", id: "gw-image" } }).generate(request)));
    expect(absent).toMatchObject({ _tag: "ModelResolutionError", reason: "provider_not_found", provider: "gateway", model: "gw-image" });
  });

  test("refuses typed when no row names an image model, or the first one lacks the image surface", async () => {
    const authFilePath = await authFile("anthropic", "gateway");
    const imageless = ProviderRow.parse({ id: "gateway", npm: "@ai-sdk/openai" });
    const none = await runEffect(Effect.flip(image({ authFilePath, rows: [imageless] }).generate({ ...request, model: "gw-1" })));
    expect(none).toMatchObject({ _tag: "ModelResolutionError", reason: "model_not_found", provider: "", model: "" });
    const anthropic = ProviderRow.parse({ id: "anthropic", npm: "@ai-sdk/anthropic", image: { model: "claude" } });
    const noSurface = await runEffect(Effect.flip(image({ authFilePath, rows: [anthropic, openai] }).generate(request)));
    expect(noSurface).toMatchObject({ _tag: "ModelResolutionError", reason: "model_not_found", provider: "anthropic", model: "claude" });
  });

  test("every settled call publishes one llm.image.completed row with the byte total", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse({ data: [{ b64_json: b64(png) }, { b64_json: b64(jpeg) }] }));
    const events = collector();
    const observed = image({ authFilePath: await authFile(), rows: [openai], events, now: ticking() });
    expect(Exit.isSuccess(await runTestExit(observed.generate({ ...request, n: 2 })))).toBe(true);
    expect(Exit.isSuccess(await runTestExit(observed.generate({ prompt: "a blue circle", traceId: "trace-image-2", n: 2 })))).toBe(true);
    expect(events.events.map((event) => event.name)).toEqual(["llm.image.completed", "llm.image.completed"]);
    expect(events.named("llm.image.completed")).toEqual([
      { traceId: "trace-image-1", time: 1_080, provider: "openai", model: "gpt-image-1", n: 2, bytes: 15, durationMs: 40 },
      { traceId: "trace-image-2", time: 1_160, provider: "openai", model: "gpt-image-1", n: 2, bytes: 15, durationMs: 40 },
    ]);
  });

  test("a failed provider call publishes exactly one llm.image.failed row", async () => {
    globalThis.fetch = mockFetch(() => new Response("{\"error\":{\"message\":\"down\"}}", { status: 500 }));
    const events = collector();
    const failed = await runTestExit(image({ authFilePath: await authFile(), rows: [openai], events, now: ticking() }).generate(request));
    expect(Exit.isFailure(failed)).toBe(true);
    expect(events.events.map((event) => event.name)).toEqual(["llm.image.failed"]);
    const [row] = events.named("llm.image.failed");
    expect(row).toEqual({ traceId: "trace-image-1", time: 1_080, provider: "openai", model: "gpt-image-1", n: 1, durationMs: 40, error: expect.any(String) });
  });

  test("no image row, a provider without the surface, missing auth and a provider failure are typed", async () => {
    globalThis.fetch = mockFetch(() => new Response("{\"error\":{\"message\":\"down\"}}", { status: 500 }));
    const authFilePath = await authFile();
    const noRow = await runTestExit(image({ authFilePath, rows: [ProviderRow.parse({ id: "openai", npm: "@ai-sdk/openai" })] }).generate(request));
    expect(Exit.isFailure(noRow) && JSON.stringify(noRow.cause)).toContain("No provider row names an image model");
    const anthropic = ProviderRow.parse({ id: "openai", npm: "@ai-sdk/anthropic", image: { model: "x" } });
    const noSurface = await runTestExit(image({ authFilePath, rows: [anthropic] }).generate(request));
    expect(Exit.isFailure(noSurface) && JSON.stringify(noSurface.cause)).toContain("has no image surface");
    const noAuth = await runTestExit(image({ authFilePath: join(dirs[0] ?? "", "absent.json") }).generate(request));
    expect(Exit.isFailure(noAuth) && JSON.stringify(noAuth.cause)).toContain("missing_auth");
    const failed = await runTestExit(image({ authFilePath }).generate(request));
    expect(Exit.isFailure(failed) && JSON.stringify(failed.cause)).toContain("APIError");
  });
});
