import { afterEach, describe, expect, test } from "bun:test";
import type { Auth } from "../../src/auth";
import type { Provider } from "../../src/provider";
import { getLanguage, getSDK } from "../../src/provider/sdk";

const originalFetch = globalThis.fetch;
type OpenAIModelRef = { readonly config?: { readonly provider?: string } };

function makeModel(overrides?: Partial<Provider.Model>): Provider.Model {
  return {
    id: "gpt-4o",
    providerID: "openai",
    name: "GPT-4o",
    api: { npm: "@ai-sdk/openai" },
    ...overrides,
  };
}

const authCases: Array<{ name: string; auth: Auth.Info }> = [
  { name: "api key auth", auth: { type: "api", key: "sk-xxx" } },
  { name: "proxy auth", auth: { type: "proxy", baseURL: "http://localhost:8317/v1" } },
  {
    name: "proxy auth with apiKey",
    auth: { type: "proxy", baseURL: "http://localhost:8317/v1", apiKey: "proxy-key" },
  },
];

describe("getSDK (OpenAI)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test.each(authCases)("$name returns SDK", ({ auth }) => {
    const sdk = getSDK(makeModel(), auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");
    const lm = sdk.languageModel("gpt-4o");
    expect(lm).toBeDefined();
    expect(lm.modelId).toBe("gpt-4o");
  });

  test("proxy auth uses Chat Completions language model", () => {
    const lm = getLanguage(makeModel({ id: "gpt-5.4" }), authCases[2]?.auth as Auth.Info);
    expect(lm.modelId).toBe("gpt-5.4");
    expect((lm as OpenAIModelRef).config?.provider).toBe("openai.chat");
  });

  test("rejects an OpenAI model wired to an SDK without Responses support", () => {
    const malformed = makeModel({
      id: "gpt-malformed-provider",
      api: { npm: "@ai-sdk/anthropic" },
    });

    expect(() => getLanguage(malformed, { type: "api", key: "test-api-key" })).toThrow(
      "OpenAI responses model loader requires responses support",
    );
  });
});
