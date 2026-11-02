import { afterEach, describe, expect, test } from "bun:test";
import type { Auth } from "../../src/auth";
import type { Provider } from "../../src/provider";
import { getLanguage, getSDK } from "../../src/provider/sdk";

const originalFetch = globalThis.fetch;
const authCases: Array<{ name: string; auth: Auth.Info }> = [
  { name: "api key auth", auth: { type: "api", key: "sk-xxx" } },
  { name: "proxy auth", auth: { type: "proxy", baseURL: "http://localhost:8317" } },
];

function makeModel(overrides?: Partial<Provider.Model>): Provider.Model {
  return {
    id: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    name: "Claude Sonnet 4",
    api: { npm: "@ai-sdk/anthropic" },
    limit: { context: 200000 },
    ...overrides,
  };
}

describe("getSDK (Anthropic)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test.each(authCases)("$name returns SDK with languageModel", ({ auth }) => {
    const sdk = getSDK(makeModel(), auth);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");
    const lm = sdk.languageModel("claude-sonnet-4-20250514");
    expect(lm).toBeDefined();
    expect(lm.modelId).toBe("claude-sonnet-4-20250514");
  });
});

describe("getLanguage (Anthropic)", () => {
  test.each(authCases)("returns a language model with $name", ({ auth }) => {
    const model = getLanguage(makeModel(), auth);
    expect(model).toBeDefined();
    expect(model.modelId).toBe("claude-sonnet-4-20250514");
  });

  test("uses api.id when provided", () => {
    const model = getLanguage(
      makeModel({ api: { npm: "@ai-sdk/anthropic", id: "claude-3-haiku" } }),
      { type: "api", key: "sk-xxx" },
    );
    expect(model).toBeDefined();
    expect(model.modelId).toBe("claude-3-haiku");
  });
});
