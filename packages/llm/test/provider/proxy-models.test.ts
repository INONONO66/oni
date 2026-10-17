import { runEffect } from "../helpers/native";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Auth } from "../../src/auth";
import { ModelsDev } from "../../src/model";
import { resetCatalog } from "../helpers/model-loader";
import { Provider } from "../../src/provider";
import { enrichWithCatalog, fetchProxyModels, proxyModelsCacheKey } from "../../src/provider/proxy-models";
import { fixedNow } from "../helpers/fixtures";

type FetchArgs = Parameters<typeof fetch>;
const originalFetch = globalThis.fetch;

function stubFetch(
  handler: (input: FetchArgs[0], init?: FetchArgs[1]) => Response | Promise<Response>,
): void {
  globalThis.fetch = Object.assign(async (...args: FetchArgs) => handler(...args), {
    preconnect: originalFetch.preconnect,
  });
}

describe("proxy-models", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    resetCatalog();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetCatalog();
  });

  describe("fetchProxyModels", () => {
    it.each([
      {
        name: "sends Authorization header when apiKey is provided",
        port: 3100,
        apiKey: "test-key-123",
        expected: "Bearer test-key-123",
      },
      {
        name: "omits Authorization header when apiKey is not provided",
        port: 3101,
        apiKey: undefined,
        expected: null,
      },
    ])("$name", async ({ port, apiKey, expected }) => {
      let capturedHeaders: Headers | undefined;
      stubFetch((_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const result = await runEffect(fetchProxyModels(`http://localhost:${port}/v1`, fixedNow, apiKey));
      expect(result).toEqual(["test-model"]);
      expect(capturedHeaders?.get("Authorization")).toBe(expected);
    });

    it("keeps exactly the valid IDs when objects and non-object entries are mixed", async () => {
      stubFetch(() =>
        Response.json({
          data: [
            { id: "first" },
            { id: 42 },
            { other: "ignored" },
            { id: "" },
            null,
            "ignored",
            42,
            false,
            [],
            { id: "second", extra: "allowed" },
          ],
        }),
      );

      expect(await runEffect(fetchProxyModels("https://mixed-entries-proxy.example/v1", fixedNow))).toEqual([
        "first",
        "second",
      ]);
    });

    it("does not share cached model lists between credentials at the same URL", async () => {
      const authorizationHeaders: Array<string | null> = [];
      stubFetch((_input, init) => {
        const authorization = new Headers(init?.headers).get("Authorization");
        authorizationHeaders.push(authorization);
        const id = authorization === "Bearer credential-a" ? "model-a" : "model-b";
        return new Response(JSON.stringify({ data: [{ id }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      expect(await runEffect(fetchProxyModels("http://localhost:3110/v1", fixedNow, "credential-a"))).toEqual([
        "model-a",
      ]);
      expect(await runEffect(fetchProxyModels("http://localhost:3110/v1", fixedNow, "credential-b"))).toEqual([
        "model-b",
      ]);
      expect(authorizationHeaders).toEqual(["Bearer credential-a", "Bearer credential-b"]);
    });

    it("does not retain credential material in cache keys", () => {
      const credential = "credential-material-that-must-not-be-exposed";
      const cacheKey = proxyModelsCacheKey("https://credential-safe.example/v1/models", credential);

      expect(cacheKey).toContain(createHash("sha256").update(credential).digest("hex"));
      expect(cacheKey).not.toContain(credential);
      expect(cacheKey).not.toContain(credential.slice(0, 12));
    });

    it("keeps only the most recently used keys once the cache is full", async () => {
      const maxEntries = 64;
      const fetched: string[] = [];
      stubFetch((input) => {
        fetched.push(String(input));
        return Response.json({ data: [{ id: "model" }] });
      });
      const proxy = (index: number) => `https://bounded-${index}.example/v1`;
      for (let index = 0; index < 2 * maxEntries; index++) await runEffect(fetchProxyModels(proxy(index), fixedNow));
      expect(fetched).toHaveLength(2 * maxEntries);

      // The newest maxEntries keys are all still served from cache...
      for (let index = 2 * maxEntries - 1; index >= maxEntries; index--) await runEffect(fetchProxyModels(proxy(index), fixedNow));
      const retained = 2 * maxEntries - (fetched.length - 2 * maxEntries);
      expect(fetched).toHaveLength(2 * maxEntries);
      // ...and the next-newest one was evicted, so exactly maxEntries entries remained.
      await runEffect(fetchProxyModels(proxy(maxEntries - 1), fixedNow));
      expect(fetched.slice(2 * maxEntries)).toEqual(["https://bounded-63.example/v1/models"]);
      console.log(`proxy-models cache: ${2 * maxEntries} distinct keys -> ${retained - maxEntries} entries retained (max ${maxEntries})`);
    });

    it("refetches a key whose cached list outlived its TTL", async () => {
      let clock = 0;
      let fetches = 0;
      stubFetch(() => {
        fetches++;
        return Response.json({ data: [{ id: `model-${fetches}` }] });
      });
      const url = "https://ttl-proxy.example/v1";
      expect(await runEffect(fetchProxyModels(url, () => clock))).toEqual(["model-1"]);
      clock = 5 * 60 * 1000 - 1;
      expect(await runEffect(fetchProxyModels(url, () => clock))).toEqual(["model-1"]);
      clock = 5 * 60 * 1000;
      expect(await runEffect(fetchProxyModels(url, () => clock))).toEqual(["model-2"]);
      expect(fetches).toBe(2);
    });

    it("keeps a TTL-refreshed hot key when the cache cap evicts the coldest key", async () => {
      const maxEntries = 64;
      let clock = 0;
      const fetched: string[] = [];
      stubFetch((input) => {
        fetched.push(String(input));
        return Response.json({ data: [{ id: String(input) }] });
      });
      const proxy = (index: number) => `https://ttl-lru-${index}.example/v1`;

      await runEffect(fetchProxyModels(proxy(0), () => clock));
      for (let index = 1; index < maxEntries; index++) await runEffect(fetchProxyModels(proxy(index), () => clock));

      clock = 5 * 60 * 1000;
      await runEffect(fetchProxyModels(proxy(0), () => clock));
      await runEffect(fetchProxyModels(proxy(maxEntries), () => clock));
      await runEffect(fetchProxyModels(proxy(0), () => clock));
      await runEffect(fetchProxyModels(proxy(1), () => clock));

      expect(fetched).toEqual([
        ...Array.from({ length: maxEntries }, (_, index) => `${proxy(index)}/models`),
        `${proxy(0)}/models`,
        `${proxy(maxEntries)}/models`,
        `${proxy(1)}/models`,
      ]);
    });

    it("joins concurrent lookups of one key onto a single fetch", async () => {
      const callers = 8;
      let fetches = 0;
      const release = Promise.withResolvers<void>();
      stubFetch(async () => {
        fetches++;
        await release.promise;
        return Response.json({ data: [{ id: "shared" }] });
      });
      // A clock that expires every entry it is asked about: only joining the
      // in-flight fetch, never a cache hit, can keep the count at one.
      let clock = 0;
      const expiring = () => (clock += 10 * 60 * 1000);
      const lookups = Array.from({ length: callers }, () => runEffect(fetchProxyModels("https://single-flight.example/v1", expiring)));
      release.resolve();

      expect(await Promise.all(lookups)).toEqual(Array.from({ length: callers }, () => ["shared"]));
      console.log(`proxy-models single flight: ${callers} concurrent lookups -> ${fetches} fetch`);
      expect(fetches).toBe(1);
    });

    it("shares one failed fetch with every joined caller and caches nothing", async () => {
      let fetches = 0;
      const release = Promise.withResolvers<void>();
      stubFetch(async () => {
        fetches++;
        await release.promise;
        return new Response("", { status: 503 });
      });
      const url = "https://single-flight-failure.example/v1";
      const lookups = [runEffect(fetchProxyModels(url, fixedNow)), runEffect(fetchProxyModels(url, fixedNow))];
      release.resolve();

      const settled = await Promise.allSettled(lookups);
      expect(settled.map((outcome) => outcome.status === "rejected" && outcome.reason)).toMatchObject([
        { _tag: "ProxyModelsError", status: 503 },
        { _tag: "ProxyModelsError", status: 503 },
      ]);
      await expect(runEffect(fetchProxyModels(url, fixedNow))).rejects.toMatchObject({ _tag: "ProxyModelsError", status: 503 });
      expect(fetches).toBe(2);
    });

    it("throws a typed error on auth failure (401) instead of returning []", async () => {
      stubFetch(() => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));
      await expect(runEffect(fetchProxyModels("http://localhost:3102/v1", fixedNow))).rejects.toMatchObject({
        _tag: "ProxyModelsError", status: 401, url: "http://localhost:3102/v1/models",
      });
    });

    it.each([
      {
        name: "throws a typed error when the proxy is unreachable",
        port: 3103,
        response: () => {
          throw new Error("ECONNREFUSED");
        },
        message: "proxy model listing unreachable",
      },
      {
        name: "throws a typed error when the proxy returns invalid JSON",
        port: 3104,
        response: () => new Response("<html>gateway timeout</html>", { status: 200 }),
        message: "proxy model listing returned invalid JSON",
      },
    ])("$name", async ({ port, response, message }) => {
      stubFetch(response);
      await expect(runEffect(fetchProxyModels(`http://localhost:${port}/v1`, fixedNow))).rejects.toThrow(message);
    });
  });

  describe("Provider.resolveModel proxy discovery", () => {
    it("resolves a model advertised only by the configured proxy", async () => {
      const directory = mkdtempSync(join(tmpdir(), "openomni-proxy-registry-"));
      const authFilePath = join(directory, "auth.json");
      const previousModelsPath = process.env.OPENOMNI_MODELS_PATH;
      const previousModelsUrl = process.env.OPENOMNI_MODELS_URL;
      const previousDisableFetch = process.env.OPENOMNI_DISABLE_MODELS_FETCH;
      process.env.OPENOMNI_MODELS_PATH = join(directory, "models.json");
      process.env.OPENOMNI_MODELS_URL = "https://models.dev";
      delete process.env.OPENOMNI_DISABLE_MODELS_FETCH;
      stubFetch((input) => {
        const url = String(input);
        if (url === "https://models.dev/api.json") {
          return new Response(
            JSON.stringify({
              openai: {
                id: "openai",
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                models: {},
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "http://localhost:3199/v1/models") {
          return new Response(JSON.stringify({ data: [{ id: "proxy-only-model" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      try {
        resetCatalog();
        await runEffect(ModelsDev.get());
        await runEffect(Auth.set("openai", {
          type: "proxy",
          baseURL: "http://localhost:3199/v1",
          apiKey: "proxy-key",
        }, { id: () => "tmp-proxy-models", authFilePath }));
        const model = await runEffect(Provider.resolveModel({ authFilePath, provider: "openai", id: "proxy-only-model", now: fixedNow }));

        expect(model).toMatchObject({ id: "proxy-only-model", providerID: "openai" });
      } finally {
        if (previousModelsPath === undefined) delete process.env.OPENOMNI_MODELS_PATH;
        else process.env.OPENOMNI_MODELS_PATH = previousModelsPath;
        if (previousModelsUrl === undefined) delete process.env.OPENOMNI_MODELS_URL;
        else process.env.OPENOMNI_MODELS_URL = previousModelsUrl;
        if (previousDisableFetch === undefined) delete process.env.OPENOMNI_DISABLE_MODELS_FETCH;
        else process.env.OPENOMNI_DISABLE_MODELS_FETCH = previousDisableFetch;
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  describe("enrichWithCatalog", () => {
    it("returns catalog model when available, stub otherwise", () => {
      const catalog: Record<string, Provider.Model> = {
        "gpt-5.4": {
          id: "gpt-5.4",
          providerID: "openai",
          name: "GPT 5.4",
        },
      };
      const result = enrichWithCatalog(["gpt-5.4", "gpt-5.5"], catalog, "openai");
      expect(result).toHaveLength(2);
      expect(result[0]?.name).toBe("GPT 5.4");
      expect(result[1]?.id).toBe("gpt-5.5");
      expect(result[1]?.name).toBe("gpt-5.5");
    });
  });
});
