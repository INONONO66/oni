import { runEffect } from "../helpers/native";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelsDev } from "../../src/model";
import { Catalog } from "../../src/model/schema";
import snapshot from "../../src/model/models-snapshot.json";
import { resetCatalog } from "../helpers/model-loader";
import { mockFetch, jsonResponse } from "../helpers/provider-fetch";

const expectedSnapshot = Catalog.parse(snapshot);
const fixture = { fixture: { id: "fixture", name: "Fixture", env: [], models: {} } };

describe("ModelsDev", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let directory: string;
  let originalFetch: typeof fetch;
  const network = mock(() => Promise.reject(new Error("offline")));

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    directory = mkdtempSync(join(tmpdir(), "models-test-"));
    process.env.ONI_MODELS_PATH = join(directory, "models.json");
    process.env.ONI_DISABLE_MODELS_FETCH = "1";
    network.mockClear();
    globalThis.fetch = Object.assign(network, { preconnect: originalFetch.preconnect });
    resetCatalog();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetCatalog();
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  });

  it("exposes only the supported catalog operation", () => {
    expect(Object.keys(ModelsDev)).toEqual(["get"]);
  });

  it("loads asynchronously", async () => {
    const pending = runEffect(ModelsDev.get());
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual(expectedSnapshot);
  });

  it("returns decoded provider and model identities", async () => {
    const data = await runEffect(ModelsDev.get());
    expect(data.anthropic?.id).toBe("anthropic");
    expect(data.anthropic?.models["claude-opus-4-5"]?.id).toBe("claude-opus-4-5");
  });

  it("returns the same cached result on a second call", async () => {
    const first = await runEffect(ModelsDev.get());
    expect(await runEffect(ModelsDev.get())).toBe(first);
  });

  it("coalesces concurrent catalog loads", async () => {
    const load = mock(() => Promise.resolve(fixture));
    resetCatalog(load);
    const [first, second] = await Promise.all([runEffect(ModelsDev.get()), runEffect(ModelsDev.get())]);
    expect(first).toBe(second);
    expect(first).toBe(fixture);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not reload a completed catalog", async () => {
    const load = mock(() => Promise.resolve(fixture));
    resetCatalog(load);
    await runEffect(ModelsDev.get());
    await runEffect(ModelsDev.get());
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("isolates the next catalog owner from a previous loaded value", async () => {
    resetCatalog(() => Promise.resolve(fixture));
    expect(await runEffect(ModelsDev.get())).toBe(fixture);
    resetCatalog();
    expect(await runEffect(ModelsDev.get())).toEqual(expectedSnapshot);
  });

  it("uses ONI_MODELS_PATH for cache location", async () => {
    process.env.ONI_MODELS_PATH = join(directory, "custom.json");
    const cached = {
      custom: { id: "custom", name: "Custom", env: [], npm: "@ai-sdk/openai", models: {} },
    };
    await Bun.write(process.env.ONI_MODELS_PATH, JSON.stringify(cached));
    expect(await runEffect(ModelsDev.get())).toEqual(cached);
    expect(network).not.toHaveBeenCalled();
  });

  it("skips fetch when ONI_DISABLE_MODELS_FETCH is set", async () => {
    expect(await runEffect(ModelsDev.get())).toEqual(expectedSnapshot);
    expect(network).not.toHaveBeenCalled();
  });

  it("returns the snapshot when fetch and cache fail", async () => {
    delete process.env.ONI_DISABLE_MODELS_FETCH;
    expect(await runEffect(ModelsDev.get())).toEqual(expectedSnapshot);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("reports a cache that cannot be written as a typed cache_write refusal", async () => {
    delete process.env.ONI_DISABLE_MODELS_FETCH;
    process.env.ONI_MODELS_PATH = directory;
    const remote = {
      openai: { id: "openai", name: "OpenAI", env: [], npm: "@ai-sdk/openai", models: {} },
    };
    globalThis.fetch = mockFetch(() => jsonResponse(remote));
    await expect(runEffect(ModelsDev.get())).rejects.toMatchObject({
      _tag: "ModelCatalogError",
      source: "cache_write",
      path: directory,
    });
  });

  it("propagates an unavailable snapshot instead of fabricating an empty catalog", async () => {
    const error = new Error("snapshot unavailable");
    resetCatalog(() => Promise.reject(error));
    await expect(runEffect(ModelsDev.get())).rejects.toMatchObject({ _tag: "TransportFailure", cause: error });
    expect(network).not.toHaveBeenCalled();
  });
});
