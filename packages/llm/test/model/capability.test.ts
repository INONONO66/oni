import { describe, expect, test } from "bun:test";
import { Capability } from "../../src";
import snapshot from "../../src/model/models-snapshot.json";
import { Catalog, RemoteCatalog } from "../../src/model/schema";
import { Provider } from "../../src/provider";

const catalog = Catalog.parse(snapshot);

function bundled(provider: string, id: string) {
  const entry = catalog[provider];
  const model = entry?.models[id];
  if (entry === undefined || model === undefined) throw new Error(`${provider}/${id} missing from the snapshot`);
  return Provider.fromModelsDevModel(entry, model);
}

describe("model input capability", () => {
  test("a model without an input row reads text only and no model accepts a generic file", () => {
    expect(Capability.accepts({}, "text")).toBe(true);
    expect(Capability.accepts({}, "image")).toBe(false);
    expect(Capability.accepts({ input: ["text", "image", "audio", "video"] }, "video")).toBe(false);
    expect(Capability.accepts({ input: ["text", "image", "audio", "video"] }, "file")).toBe(false);
  });

  test.each([
    ["@ai-sdk/openai", "chat"],
    ["@ai-sdk/openai", "responses"],
    ["@ai-sdk/openai", undefined],
    ["@ai-sdk/anthropic", undefined],
    ["unbundled", undefined],
  ] as const)("%s %s only accepts transportable catalog modalities", (npm, style) => {
    const model = { input: ["text", "image", "audio", "video"] as const, api: { npm, style } };
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"])
      expect(Capability.accepts(model, { kind: "image", mime })).toBe(true);
    expect(Capability.accepts(model, { kind: "image", mime: "image/heic" })).toBe(false);
    for (const mime of ["audio/wav", "audio/mpeg", "audio/mp3"])
      expect(Capability.accepts(model, { kind: "audio", mime })).toBe(npm === "@ai-sdk/openai" && style === "chat");
    expect(Capability.accepts(model, { kind: "audio", mime: "audio/ogg" })).toBe(false);
    expect(Capability.accepts(model, { kind: "video", mime: "video/mp4" })).toBe(false);
    expect(Capability.accepts(model, { kind: "file", mime: "application/pdf" })).toBe(false);
    expect(Capability.accepts({ ...model, input: ["text"] }, { kind: "image", mime: "image/png" })).toBe(false);
  });

  test("bundled rows carry the input modalities through to the provider model", () => {
    expect(bundled("anthropic", "claude-sonnet-4-5").input).toEqual(["text", "image"]);
    expect(Capability.accepts(bundled("openai", "gpt-5"), "image")).toBe(true);
    expect(Capability.accepts(bundled("openai", "gpt-4o"), "audio")).toBe(false);
    expect(Capability.accepts(bundled("openai", "o3-mini"), "image")).toBe(false);
    expect(bundled("openai", "text-embedding-3-small").input).toBeUndefined();
  });

  test("the remote catalog maps nested modalities and drops kinds no row speaks for", () => {
    const remote = RemoteCatalog.parse({
      google: {
        name: "Google",
        env: [],
        npm: "@ai-sdk/openai",
        models: {
          omni: { id: "omni", name: "Omni", modalities: { input: ["text", "image", "audio", "video", "pdf"], output: ["text"] } },
          plain: { id: "plain", name: "Plain" },
          cached: { id: "cached", name: "Cached", input: ["text", "audio"] },
        },
      },
    });
    const models = remote.google?.models;
    expect(models?.omni?.input).toEqual(["text", "image", "audio", "video"]);
    expect(models?.plain?.input).toBeUndefined();
    expect(models?.cached?.input).toEqual(["text", "audio"]);
    expect(() => RemoteCatalog.parse({
      x: { name: "X", env: [], npm: "@ai-sdk/openai", models: { m: { id: "m", name: "M", input: ["smell"] } } },
    })).toThrow();
  });
});
