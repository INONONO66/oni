import { describe, expect, test } from "bun:test";
import type { Auth } from "../../src/auth";
import { getLanguage, getSDK } from "../../src/provider/sdk";
import type { Provider } from "../../src/provider";

const SDK_CACHE_LIMIT = 64;
const LANGUAGE_CACHE_LIMIT = 256;

function makeAnthropicModel(id = "claude-sonnet-4-20250514"): Provider.Model {
  return {
    id,
    providerID: "anthropic",
    name: "Claude Sonnet 4",
    api: { npm: "@ai-sdk/anthropic" },
  };
}

function makeOpenAIModel(id = "gpt-4o"): Provider.Model {
  return {
    id,
    providerID: "openai",
    name: "GPT-4o",
    api: { npm: "@ai-sdk/openai" },
  };
}

describe("provider caches", () => {
  test("reuses SDK for the same provider and auth", () => {
    const auth: Auth.Info = { type: "api", key: "sk-test" };

    const first = getSDK(makeAnthropicModel(), auth);
    const second = getSDK(makeAnthropicModel(), auth);

    expect(first).toBe(second);
  });

  test("reuses SDK across models when provider and auth are the same", () => {
    const auth: Auth.Info = { type: "api", key: "sk-test" };

    const first = getSDK(makeAnthropicModel("claude-sonnet-4-20250514"), auth);
    const second = getSDK(makeAnthropicModel("claude-opus-4-20250514"), auth);

    expect(first).toBe(second);
  });

  test("returns different SDKs for different auth values", () => {
    const first = getSDK(makeOpenAIModel(), { type: "api", key: "sk-test-1" });
    const second = getSDK(makeOpenAIModel(), { type: "api", key: "sk-test-2" });

    expect(first).not.toBe(second);
  });

  test("reuses language models for the same model and auth", () => {
    const auth: Auth.Info = { type: "proxy", baseURL: "http://localhost:8317" };

    const first = getLanguage(makeAnthropicModel(), auth);
    const second = getLanguage(makeAnthropicModel(), auth);

    expect(first).toBe(second);
  });

  test("returns different language models for different models", () => {
    const auth: Auth.Info = { type: "proxy", baseURL: "http://localhost:8317" };

    const first = getLanguage(makeAnthropicModel("claude-sonnet-4-20250514"), auth);
    const second = getLanguage(makeAnthropicModel("claude-opus-4-20250514"), auth);

    expect(first).not.toBe(second);
  });

  test("returns different language models for different auth values", () => {
    const first = getLanguage(makeOpenAIModel(), { type: "api", key: "sk-test-1" });
    const second = getLanguage(makeOpenAIModel(), { type: "api", key: "sk-test-2" });

    expect(first).not.toBe(second);
  });

  test("evicts least-recently-used SDK entries after the cache limit", () => {
    const model = makeOpenAIModel();
    const firstAuth: Auth.Info = { type: "api", key: "sk-lru-0" };
    const first = getSDK(model, firstAuth);

    for (let i = 1; i <= SDK_CACHE_LIMIT; i++) {
      getSDK(model, { type: "api", key: `sk-lru-${i}` });
    }

    expect(getSDK(model, firstAuth)).not.toBe(first);
  });

  test("touching an SDK cache entry keeps it across eviction", () => {
    const model = makeOpenAIModel();
    const firstAuth: Auth.Info = { type: "api", key: "sk-touch-0" };
    const first = getSDK(model, firstAuth);

    for (let i = 1; i < SDK_CACHE_LIMIT; i++) {
      getSDK(model, { type: "api", key: `sk-touch-${i}` });
    }
    expect(getSDK(model, firstAuth)).toBe(first);
    getSDK(model, { type: "api", key: "sk-touch-evict" });

    expect(getSDK(model, firstAuth)).toBe(first);
  });

  test("bounds language model cache entries", () => {
    const auth: Auth.Info = { type: "proxy", baseURL: "http://localhost:8317" };
    const first = getLanguage(makeAnthropicModel("claude-lru-0"), auth);

    for (let i = 1; i <= LANGUAGE_CACHE_LIMIT; i++) {
      getLanguage(makeAnthropicModel(`claude-lru-${i}`), auth);
    }

    expect(getLanguage(makeAnthropicModel("claude-lru-0"), auth)).not.toBe(first);
  });
});
