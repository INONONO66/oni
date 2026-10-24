import { runEffect } from "../helpers/native";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlainObject } from "@oni/protocol";
import { Effect } from "effect";
import { ModelsDev } from "../../src/model";
import { Capability } from "../../src/model/capability";
import { ModelCatalogError } from "../../src/errors";
import { Catalog } from "../../src/model/schema";
import { resetCatalog } from "../helpers/model-loader";

type RemoteCatalogCase<Selected> = {
  readonly name: string;
  /** The JSON body the remote catalog answers with. */
  readonly catalog: PlainObject;
  readonly select: (data: Record<string, ModelsDev.Provider>) => Selected;
  readonly expected: Selected;
};

function remoteCase<Selected>(testCase: RemoteCatalogCase<Selected>): RemoteCatalogCase<Selected> {
  return testCase;
}

const remoteCatalogCases = [
  remoteCase({
    name: "prefers a successful fetch over the bundled snapshot",
    catalog: {
      "test-network-provider": {
        api: "https://attacker.example/v1",
        id: "test-network-provider",
        name: "Network Provider",
        env: ["TEST_NETWORK_PROVIDER_API_KEY"],
        npm: "@ai-sdk/openai",
        models: {
          "test-network-model": {
            id: "test-network-model",
            name: "Network Model",
            provider: { npm: "@ai-sdk/anthropic" },
          },
        },
      },
    },
    select: (data) => data["test-network-provider"],
    expected: {
      env: ["TEST_NETWORK_PROVIDER_API_KEY"],
      id: "test-network-provider",
      models: { "test-network-model": { id: "test-network-model", name: "Network Model" } },
      name: "Network Provider",
      npm: "@ai-sdk/openai",
    },
  }),
  remoteCase({
    name: "drops custom providers without a bundled SDK",
    catalog: {
      custom: {
        api: "https://attacker.example/v1",
        id: "custom",
        name: "Custom Provider",
        env: ["CUSTOM_API_KEY"],
        models: { "custom-model": { id: "custom-model", name: "Custom Model" } },
      },
    },
    select: (data) => data.custom,
    expected: undefined,
  }),
  remoteCase({
    name: "removes model-level provider packages",
    catalog: {
      openai: {
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        models: {
          "gpt-test": {
            id: "gpt-test",
            name: "GPT Test",
            provider: { npm: "@ai-sdk/anthropic" },
          },
        },
      },
    },
    select: (data) => data.openai?.models["gpt-test"],
    expected: { id: "gpt-test", name: "GPT Test" },
  }),
];

describe("ModelsDev catalog loading", () => {
  const originalEnv = { ...process.env };
  let testCacheDir: string | undefined;

  beforeEach(() => {
    resetCatalog();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    if (testCacheDir) {
      await rm(testCacheDir, { force: true, recursive: true });
      testCacheDir = undefined;
    }
  });

  async function withFetch(
    answer: () => Promise<Response>,
    body: () => Promise<void>,
  ): Promise<void> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(mock(answer), { preconnect: originalFetch.preconnect });
    try {
      await body();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  async function writeCacheCatalog(content: string | PlainObject): Promise<void> {
    testCacheDir = mkdtempSync(join(tmpdir(), "oni-models-cache-"));
    process.env.ONI_MODELS_PATH = join(testCacheDir, "models.json");
    process.env.ONI_DISABLE_MODELS_FETCH = "1";
    await Bun.write(
      process.env.ONI_MODELS_PATH,
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }

  describe("get", () => {
    it.each(remoteCatalogCases)("$name", async ({ catalog, select, expected }) => {
      testCacheDir = mkdtempSync(join(tmpdir(), "oni-models-network-"));
      process.env.ONI_MODELS_PATH = join(testCacheDir, "models.json");
      delete process.env.ONI_DISABLE_MODELS_FETCH;

      const originalFetch = globalThis.fetch;
      const fetchSpy = Object.assign(
        mock(() =>
          Promise.resolve(
            new Response(JSON.stringify(catalog), {
              headers: { "content-type": "application/json" },
              status: 200,
            }),
          ),
        ),
        { preconnect: originalFetch.preconnect },
      );
      globalThis.fetch = fetchSpy;

      try {
        const data = await runEffect(ModelsDev.get());
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(select(data)).toEqual(expected);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should not trust provider api urls from an existing trusted-provider cache file", async () => {
      await writeCacheCatalog({
        cached: {
          api: "https://attacker.example/v1",
          id: "cached",
          name: "Cached Provider",
          env: ["CACHED_API_KEY"],
          npm: "@ai-sdk/openai",
          models: {},
        },
      });

      const data = await runEffect(ModelsDev.get());
      expect(data.cached).toEqual({
        id: "cached",
        name: "Cached Provider",
        env: ["CACHED_API_KEY"],
        npm: "@ai-sdk/openai",
        models: {},
      });
    });

    it("fills known missing capabilities from the bundled snapshot without changing unknown models", async () => {
      await writeCacheCatalog({
        openai: {
          id: "openai",
          name: "OpenAI",
          env: ["OPENAI_API_KEY"],
          npm: "@ai-sdk/openai",
          models: {
            "gpt-4o": { id: "gpt-4o", name: "Cached GPT-4o" },
            "local-model": { id: "local-model", name: "Local Model" },
          },
        },
      });

      const data = await runEffect(ModelsDev.get());
      expect(data.openai?.models["gpt-4o"]?.input).toEqual(["text", "image"]);
      expect(Capability.accepts(data.openai?.models["gpt-4o"] ?? {}, { kind: "image", mime: "image/png" })).toBe(true);
      expect(data.openai?.models["local-model"]?.input).toBeUndefined();
      expect(Capability.accepts(data.openai?.models["local-model"] ?? {}, { kind: "image", mime: "image/png" })).toBe(false);
      const path = process.env.ONI_MODELS_PATH;
      if (path === undefined) throw new Error("cache path missing");
      expect(Catalog.parse(await Bun.file(path).json()).openai?.models["gpt-4o"]?.input).toBeUndefined();
    });

    it("refuses a cache file whose trusted provider is malformed with a typed cache error", async () => {
      await writeCacheCatalog({
        openai: null,
        anthropic: {
          id: "anthropic",
          name: "Anthropic",
          env: "ANTHROPIC_API_KEY",
          npm: "@ai-sdk/anthropic",
          models: {},
        },
      });

      const error = await runEffect(Effect.flip(ModelsDev.get()));
      expect(error).toBeInstanceOf(ModelCatalogError);
      expect(error).toMatchObject({ source: "cache", path: process.env.ONI_MODELS_PATH });
    });

    it("refuses a cache file with a malformed model record instead of dropping it", async () => {
      await writeCacheCatalog({
        openai: {
          id: "openai",
          name: "OpenAI",
          env: ["OPENAI_API_KEY"],
          npm: "@ai-sdk/openai",
          models: {
            malformed: { family: "no-id-or-name" },
            valid: { id: "valid", name: "Valid Model" },
          },
        },
      });

      const error = await runEffect(Effect.flip(ModelsDev.get()));
      expect(error).toBeInstanceOf(ModelCatalogError);
      expect(error).toMatchObject({ source: "cache" });
      expect(String(error)).toContain("models.malformed");
    });

    it("refuses a cache file that is not JSON with a typed cache error", async () => {
      await writeCacheCatalog("not json {");

      const error = await runEffect(Effect.flip(ModelsDev.get()));
      expect(error).toBeInstanceOf(ModelCatalogError);
      expect(error).toMatchObject({ source: "cache", path: process.env.ONI_MODELS_PATH });
    });

    it("uses the bundled snapshot when the cache is empty and fetching is disabled", async () => {
      await writeCacheCatalog({});

      const snapshot = (await import("../../src/model/models-snapshot.json")).default;
      await expect(runEffect(ModelsDev.get())).resolves.toEqual(Catalog.parse(snapshot));
    });

    it("continues to the bundled snapshot when the remote fetch fails (typed remote refusal)", async () => {
      testCacheDir = mkdtempSync(join(tmpdir(), "oni-models-offline-"));
      process.env.ONI_MODELS_PATH = join(testCacheDir, "models.json");
      delete process.env.ONI_DISABLE_MODELS_FETCH;
      await withFetch(() => Promise.reject(new Error("network down")), async () => {
        const snapshot = (await import("../../src/model/models-snapshot.json")).default;
        await expect(runEffect(ModelsDev.get())).resolves.toEqual(Catalog.parse(snapshot));
      });
    });

    it("continues to the bundled snapshot when the remote answers non-OK or malformed", async () => {
      for (const body of [new Response("oops", { status: 500 }), new Response("not json {", { status: 200 })]) {
        resetCatalog();
        testCacheDir = mkdtempSync(join(tmpdir(), "oni-models-badremote-"));
        process.env.ONI_MODELS_PATH = join(testCacheDir, "models.json");
        delete process.env.ONI_DISABLE_MODELS_FETCH;
        await withFetch(() => Promise.resolve(body), async () => {
          const snapshot = (await import("../../src/model/models-snapshot.json")).default;
          await expect(runEffect(ModelsDev.get())).resolves.toEqual(Catalog.parse(snapshot));
        });
        await rm(testCacheDir, { force: true, recursive: true });
        testCacheDir = undefined;
      }
    });

    it("continues to the bundled snapshot when a remote provider entry is malformed", async () => {
      testCacheDir = mkdtempSync(join(tmpdir(), "oni-models-badentry-"));
      process.env.ONI_MODELS_PATH = join(testCacheDir, "models.json");
      delete process.env.ONI_DISABLE_MODELS_FETCH;
      const malformed = { openai: { id: "openai", npm: "@ai-sdk/openai", models: {} } };
      await withFetch(
        () => Promise.resolve(new Response(JSON.stringify(malformed), { status: 200 })),
        async () => {
          const snapshot = (await import("../../src/model/models-snapshot.json")).default;
          await expect(runEffect(ModelsDev.get())).resolves.toEqual(Catalog.parse(snapshot));
        },
      );
    });

    it("reports a failed cache write as a typed cache_write error", async () => {
      testCacheDir = mkdtempSync(join(tmpdir(), "oni-models-readonly-"));
      const blocker = join(testCacheDir, "blocker");
      await Bun.write(blocker, "a file, not a directory");
      process.env.ONI_MODELS_PATH = join(blocker, "nested", "models.json");
      delete process.env.ONI_DISABLE_MODELS_FETCH;
      const catalog = {
        openai: { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], npm: "@ai-sdk/openai", models: {} },
      };
      await withFetch(
        () => Promise.resolve(new Response(JSON.stringify(catalog), { status: 200 })),
        async () => {
          const error = await runEffect(Effect.flip(ModelsDev.get()));
          expect(error).toBeInstanceOf(ModelCatalogError);
          expect(error).toMatchObject({ source: "cache_write", path: process.env.ONI_MODELS_PATH });
        },
      );
    });

    it("should not let prototype keys mutate sanitized catalog objects", async () => {
      const provider = {
        id: "safe",
        name: "Safe",
        env: [],
        npm: "@ai-sdk/openai",
        models: { ["__proto__"]: { id: "bad", name: "Bad" }, safe: { id: "safe", name: "Safe" } },
      };
      await writeCacheCatalog(JSON.stringify({ ["__proto__"]: provider, safe: provider }));
      const data = await runEffect(ModelsDev.get());
      expect(Object.keys(data)).toEqual(["safe"]);
      expect(Object.keys(data.safe?.models ?? {})).toEqual(["safe"]);
      expect(Reflect.ownKeys(data).includes("__proto__")).toBe(false);
    });
  });
});
