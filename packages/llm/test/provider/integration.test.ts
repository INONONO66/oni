import { describe, expect, it } from "bun:test";
import type { Auth } from "../../src/auth";
import { Provider } from "../../src/provider";
import { getLanguage, getSDK } from "../../src/provider/sdk";
import { usePrivateCatalog } from "../helpers/catalog";
import { captureRequest, openAIResponse } from "../helpers/provider-fetch";

function makeModel(provider: "anthropic" | "openai", id: string): Provider.Model {
  return {
    id,
    providerID: provider,
    name: provider === "anthropic" ? "Claude Sonnet 4" : "GPT-4o",
    api: { npm: provider === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai" },
  };
}

const sdkCases: Array<{
  name: string;
  model: Provider.Model;
  auth: Auth.Info;
  checksGetLanguage: boolean;
}> = [
  {
    name: "Anthropic API",
    model: makeModel("anthropic", "claude-sonnet-4-20250514"),
    auth: { type: "api", key: "test-anthropic-key" },
    checksGetLanguage: true,
  },
  {
    name: "Anthropic proxy",
    model: makeModel("anthropic", "claude-opus-4-20250514"),
    auth: { type: "proxy", baseURL: "http://localhost:8317" },
    checksGetLanguage: true,
  },
  {
    name: "OpenAI API",
    model: makeModel("openai", "gpt-4o"),
    auth: { type: "api", key: "test-openai-key" },
    checksGetLanguage: false,
  },
  {
    name: "OpenAI proxy",
    model: makeModel("openai", "gpt-5.1-codex-max"),
    auth: {
      type: "proxy",
      baseURL: "http://localhost:8317/v1",
      apiKey: "test-proxy-api-key",
    },
    checksGetLanguage: false,
  },
];

describe("Provider Integration", () => {
  usePrivateCatalog();

  it.each(sdkCases)("full flow: getSDK returns valid SDK ($name)", ({
    model,
    auth,
    checksGetLanguage,
  }) => {
    const sdk = getSDK(model, auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");
    const sdkLm = sdk.languageModel(model.id);
    expect(sdkLm).toBeDefined();
    expect(sdkLm.modelId).toBe(model.id);
    if (checksGetLanguage) {
      const lm = getLanguage(model, auth);
      expect(lm).toBeDefined();
      expect(lm.modelId).toBe(model.id);
    }
  });

  it("maps custom models without stale removed-provider npm metadata", () => {
    const model = Provider.fromModelsDevModel(
      { id: "custom", name: "Custom", env: [], api: "http://localhost:8317/v1", models: {} },
      { id: "custom-model", name: "Custom Model" },
    );
    expect(model.api?.npm).toBe("@ai-sdk/openai");
    expect(model.api?.url).toBe("http://localhost:8317/v1");
  });

  it("maps catalog limit.context through to the model (the run-window input)", () => {
    const provider = { id: "custom", name: "Custom", env: [], models: {} };
    const sized = Provider.fromModelsDevModel(provider, {
      id: "m",
      name: "M",
      limit: { context: 200_000 },
    });
    expect(sized.limit?.context).toBe(200_000);
    const unsized = Provider.fromModelsDevModel(provider, { id: "m", name: "M" });
    expect(unsized.limit?.context).toBe(0);
  });

  it("carries no write-only catalog metadata — status and release_date have no reader", () => {
    const upstream = { id: "m", name: "M", status: "beta", release_date: "2025-01-01" };
    const mapped = Provider.fromModelsDevModel(
      { id: "custom", name: "Custom", env: [], models: {} },
      upstream,
    );

    // Stored-but-never-read fields are dropped by the mapping AND stripped by
    // the schema, so re-adding one without a reader fails here.
    expect("status" in mapped).toBe(false);
    expect("release_date" in mapped).toBe(false);
    const parsed = Provider.Model.parse({
      ...mapped,
      status: "beta",
      release_date: "2025-01-01",
    });
    expect("status" in parsed).toBe(false);
    expect("release_date" in parsed).toBe(false);
  });

  it("honors model.api.url on the OpenAI request", async () => {
    const auth: Auth.Info = { type: "api", key: "test-openai-key" };
    const model: Provider.Model = {
      id: "gpt-4o-custom-endpoint",
      providerID: "openai",
      name: "GPT-4o (custom endpoint)",
      api: { npm: "@ai-sdk/openai", url: "http://localhost:9317/v1" },
    };
    const lm = getLanguage(model, auth);
    const { url } = await captureRequest(
      () =>
        lm.doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }),
      openAIResponse(model.id),
    );
    expect(lm.provider).toBe("openai.responses");
    expect(url).toBe("http://localhost:9317/v1/responses");
  });

  it("resolves custom baseURL models through the OpenAI provider", () => {
    const auth: Auth.Info = { type: "api", key: "custom-key" };
    const model: Provider.Model = {
      id: "custom-model",
      providerID: "custom",
      name: "Custom Model",
      api: { npm: "@ai-sdk/openai", url: "http://localhost:8317/v1" },
    };
    const sdk = getSDK(model, auth);
    expect(typeof sdk.languageModel).toBe("function");
    const lm = getLanguage(model, auth);
    expect(lm.modelId).toBe("custom-model");
    expect(lm.provider).toBe("custom.responses");
  });
});
