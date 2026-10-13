import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { anthropicResponse, captureRequest, openAIResponse } from "../helpers/provider-fetch";
import { arch, platform, release } from "node:os";
import type { Auth } from "../../src/auth";
import { clientIdentity } from "../../src/provider/identity";
import type { Provider } from "../../src/provider";
import { getLanguage, getSDK } from "../../src/provider/sdk";

/** `pi/<version> (<platform> <kernelRelease>; <arch>)` — the whole contract. */
const IDENTITY_PATTERN = /^pi\/\d+\.\d+\.\d+ \(.+; .+\)$/;

function anthropicModel(): Provider.Model {
  return {
    id: "claude-3-haiku",
    providerID: "anthropic",
    name: "Claude 3 Haiku",
    api: { npm: "@ai-sdk/anthropic" },
  };
}

function openAIModel(): Provider.Model {
  return {
    id: "gpt-4o-mini",
    providerID: "openai",
    name: "GPT-4o mini",
    api: { npm: "@ai-sdk/openai" },
  };
}

function openAICompatibleModel(): Provider.Model {
  return {
    id: "gateway-model",
    providerID: "gateway",
    name: "Gateway model",
    api: { npm: "@gateway/openai-compatible", url: "https://gateway.example/v1" },
  };
}

/**
 * The header is asserted where it actually matters — on the request the SDK
 * puts on the wire — rather than on the options object handed to the factory:
 * a default that the SDK drops on the floor would still pass the latter.
 */
async function capturedRequestHeaders(auth: Auth.Info): Promise<Headers> {
  const sdk = getSDK(anthropicModel(), auth);
  const { headers } = await captureRequest(
    () =>
      sdk.languageModel("claude-3-haiku").doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    anthropicResponse,
  );
  return headers;
}

async function capturedOpenAIRequest(
  model: Provider.Model,
): Promise<{ readonly url: string; readonly headers: Headers }> {
  return captureRequest(
    () =>
      getLanguage(model, { type: "api", key: `sk-identity-${model.providerID}` }).doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    openAIResponse(model.id),
  );
}

describe("clientIdentity", () => {
  test("renders pi/<version> (<platform> <kernelRelease>; <arch>)", () => {
    const identity = clientIdentity();

    expect(identity).toMatch(IDENTITY_PATTERN);
    expect(identity).toBe(`pi/${clientIdentity.version} (${platform()} ${release()}; ${arch()})`);
  });

  test("is pure — repeated calls render the same string", () => {
    expect(clientIdentity()).toBe(clientIdentity());
  });

  test("reports the package manifest's version", async () => {
    const manifest = z
      .object({ version: z.string() })
      .parse(await Bun.file(new URL("../../package.json", import.meta.url)).json());

    expect(clientIdentity.version).toBe(manifest.version);
  });
});

describe("provider SDK client identity header", () => {
  test("sends the pi client identity as the default user-agent", async () => {
    const headers = await capturedRequestHeaders({ type: "api", key: "sk-identity-default" });

    const userAgent = headers.get("user-agent") ?? "";
    // The AI SDK appends its own runtime segments after whatever default the
    // caller set, so the identity is the prefix, not the whole value.
    const [ours] = userAgent.split(" ai-sdk/");
    expect(ours).toMatch(IDENTITY_PATTERN);
    expect(ours).toBe(clientIdentity());
  });

  test("keeps the provider's own default headers alongside the identity", async () => {
    const headers = await capturedRequestHeaders({ type: "api", key: "sk-identity-beta" });

    expect(headers.get("anthropic-beta")).toBe(
      "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
    );
  });

  test("sends the identity through the bundled OpenAI Responses path", async () => {
    const { url, headers } = await capturedOpenAIRequest(openAIModel());

    expect(url).toContain("/responses");
    expect(headers.get("user-agent") ?? "").toStartWith(clientIdentity());
  });

  test("sends the identity through the OpenAI-compatible fallback path", async () => {
    const { url, headers } = await capturedOpenAIRequest(openAICompatibleModel());

    expect(url).toBe("https://gateway.example/v1/responses");
    expect(headers.get("user-agent") ?? "").toStartWith(clientIdentity());
  });
});
