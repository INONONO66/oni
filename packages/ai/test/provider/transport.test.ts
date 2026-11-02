import { describe, expect, test } from "bun:test";
import { anthropicResponse, captureRequest } from "../helpers/provider-fetch";
import type { Auth } from "../../src/auth";
import { clientIdentity } from "../../src/provider/identity";
import type { Provider } from "../../src/provider";
import { getSDK, type Transport } from "../../src/provider/sdk";

function anthropicModel(): Provider.Model {
  return {
    id: "claude-3-haiku",
    providerID: "anthropic",
    name: "Claude 3 Haiku",
    api: { npm: "@ai-sdk/anthropic", url: "https://api.anthropic.com/v1" },
  };
}

interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
}

/**
 * The operator's transport config is asserted on the request that leaves the
 * process, not on the options object: a value the SDK ignores would still
 * satisfy an options-level assertion while the header never shipped.
 */
async function capturedRequest(auth: Auth.Info, transport?: Transport): Promise<CapturedRequest> {
  const sdk = getSDK(anthropicModel(), auth, transport);
  return captureRequest(
    () =>
      sdk.languageModel("claude-3-haiku").doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    anthropicResponse,
  );
}

describe("operator transport config", () => {
  test("sends operator headers alongside the client identity", async () => {
    const { headers } = await capturedRequest(
      { type: "api", key: "sk-transport-headers" },
      { headers: { "x-tenant": "acme" } },
    );

    expect(headers.get("x-tenant")).toBe("acme");
    expect(headers.get("user-agent") ?? "").toStartWith(clientIdentity());
  });

  test("an operator user-agent overrides the default client identity", async () => {
    const { headers } = await capturedRequest(
      { type: "api", key: "sk-transport-override" },
      { headers: { "user-agent": "acme-fleet/2" } },
    );

    const userAgent = headers.get("user-agent") ?? "";
    expect(userAgent).toStartWith("acme-fleet/2");
    expect(userAgent).not.toContain(clientIdentity());
  });

  test("an operator baseUrl replaces the catalog's provider URL", async () => {
    const { url } = await capturedRequest(
      { type: "api", key: "sk-transport-base" },
      { baseUrl: "https://gateway.internal/v1" },
    );

    expect(url).toStartWith("https://gateway.internal/v1/");
  });

  test("proxy auth still owns the base URL — an operator override never redirects a proxied credential", async () => {
    const { url } = await capturedRequest(
      { type: "proxy", baseURL: "http://localhost:8317", apiKey: "proxied" },
      { baseUrl: "https://gateway.internal/v1" },
    );

    expect(url).toStartWith("http://localhost:8317/");
  });

  test("absent transport config leaves the catalog wiring untouched", async () => {
    const { url, headers } = await capturedRequest({ type: "api", key: "sk-transport-absent" });

    expect(url).toStartWith("https://api.anthropic.com/v1/");
    expect(headers.get("user-agent") ?? "").toStartWith(clientIdentity());
  });

  test("distinct transport config never shares a cached SDK", () => {
    const auth: Auth.Info = { type: "api", key: "sk-transport-cache" };

    const plain = getSDK(anthropicModel(), auth);
    const tenantA = getSDK(anthropicModel(), auth, { headers: { "x-tenant": "a" } });
    const tenantB = getSDK(anthropicModel(), auth, { headers: { "x-tenant": "b" } });

    expect(tenantA).not.toBe(plain);
    expect(tenantA).not.toBe(tenantB);
    expect(tenantA).toBe(getSDK(anthropicModel(), auth, { headers: { "x-tenant": "a" } }));
  });

  test("header order does not fork the SDK cache", () => {
    const auth: Auth.Info = { type: "api", key: "sk-transport-order" };

    const ab = getSDK(anthropicModel(), auth, { headers: { "x-a": "1", "x-b": "2" } });
    const ba = getSDK(anthropicModel(), auth, { headers: { "x-b": "2", "x-a": "1" } });

    expect(ba).toBe(ab);
  });
});
