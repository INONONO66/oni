import { runEffect } from "../helpers/native";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../../src/auth";
import { ModelsDev } from "../../src/model";
import { resetCatalog } from "../helpers/model-loader";
import { Provider } from "../../src/provider";
import { enrichWithCatalog, fetchProxyModels } from "../../src/provider/proxy-models";
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
