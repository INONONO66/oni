/// <reference lib="es2022.object" />
import { describe, expect, it } from "bun:test";
import type { Auth } from "../../src/auth";
import { Provider } from "../../src/provider";
import { getSDK } from "../../src/provider/sdk";
import { usePrivateCatalog } from "../helpers/catalog";

function makeModel(providerID: string, npm: string, id = "test-model"): Provider.Model {
  return { id, providerID, name: "Test Model", api: { npm } };
}

const sdkCases: Array<{
  name: string;
  providerID: string;
  npm: string;
  id: string;
  auth: Auth.Info;
}> = [
  {
    name: "Anthropic provider with API auth",
    providerID: "anthropic",
    npm: "@ai-sdk/anthropic",
    id: "claude-sonnet-4-20250514",
    auth: { type: "api", key: "test-api-key" },
  },
  {
    name: "Anthropic provider with proxy auth",
    providerID: "anthropic",
    npm: "@ai-sdk/anthropic",
    id: "claude-sonnet-4-20250514",
    auth: { type: "proxy", baseURL: "http://localhost:8317" },
  },
  {
    name: "OpenAI provider with API auth",
    providerID: "openai",
    npm: "@ai-sdk/openai",
    id: "gpt-4o",
    auth: { type: "api", key: "test-api-key" },
  },
  {
    name: "OpenAI provider with proxy auth",
    providerID: "openai",
    npm: "@ai-sdk/openai",
    id: "gpt-5.1-codex-max",
    auth: { type: "proxy", baseURL: "http://localhost:8317/v1", apiKey: "test-proxy-key" },
  },
];

describe("Provider Registry", () => {
  usePrivateCatalog();

  describe("public surface", () => {
    it("does not expose removed dead provider namespace members", () => {
      expect(Object.hasOwn(Provider, "BUNDLED_PROVIDERS")).toBe(false);
    });
  });

  describe("getSDK", () => {
    it.each(sdkCases)("should return configured $name", ({ providerID, npm, id, auth }) => {
      const provider = getSDK(makeModel(providerID, npm, id), auth);
      expect(provider).toBeDefined();
      expect(provider.languageModel).toBeDefined();
    });

    it("should throw error for unknown npm package", () => {
      expect(() =>
        getSDK(makeModel("unknown", "unknown-npm-pkg"), { type: "api", key: "test-api-key" }),
      ).toThrow("No bundled provider for npm package: unknown-npm-pkg");
    });

    it("treats Object.prototype keys as unknown npm packages", () => {
      const auth: Auth.Info = { type: "api", key: "test-api-key" };
      for (const npm of ["toString", "constructor", "valueOf"]) {
        expect(() => getSDK(makeModel("unknown", npm), auth)).toThrow(
          `No bundled provider for npm package: ${npm}`,
        );
      }
    });
  });
});