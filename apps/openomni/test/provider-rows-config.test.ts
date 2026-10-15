import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, modelTransport } from "../src/config";

const KEYS = [
  "OPENOMNI_PROVIDERS_PATH",
  "OPENOMNI_MODEL_PROVIDER",
  "OPENOMNI_MODEL_ID",
  "OPENOMNI_MODEL_API_KEY",
  "OPENOMNI_MODEL_BASE_URL",
  "OPENOMNI_MODEL_HEADERS",
  "OPENOMNI_MODEL_FALLBACKS",
  "GATEWAY_API_KEY",
] as const;

let saved: Record<string, string | undefined>;
let directory: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  directory = mkdtempSync(join(tmpdir(), "provider-rows-config-"));
  process.env.OPENOMNI_MODEL_PROVIDER = "gateway";
  process.env.OPENOMNI_MODEL_ID = "gw-1";
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

function useRows(body: string): void {
  const path = join(directory, "providers.json");
  writeFileSync(path, body);
  process.env.OPENOMNI_PROVIDERS_PATH = path;
}

const gatewayRow = {
  id: "gateway",
  npm: "@ai-sdk/openai",
  baseUrl: "http://127.0.0.1:9/v1",
  headers: { "x-tenant": "acme" },
  auth: "GATEWAY_API_KEY",
};

describe("OPENOMNI_PROVIDERS_PATH", () => {
  it("resolves the same model config as the equivalent env tuple", () => {
    process.env.OPENOMNI_MODEL_API_KEY = "sk-gw";
    process.env.OPENOMNI_MODEL_BASE_URL = gatewayRow.baseUrl;
    process.env.OPENOMNI_MODEL_HEADERS = JSON.stringify(gatewayRow.headers);
    const fromEnv = loadConfig().model;

    for (const key of ["OPENOMNI_MODEL_API_KEY", "OPENOMNI_MODEL_BASE_URL", "OPENOMNI_MODEL_HEADERS"]) delete process.env[key];
    process.env.GATEWAY_API_KEY = "sk-gw";
    useRows(JSON.stringify({ providers: [gatewayRow] }));
    const fromRows = loadConfig().model;

    expect(fromRows).toEqual(fromEnv);
    expect(modelTransport(fromRows)).toEqual({ baseUrl: gatewayRow.baseUrl, headers: gatewayRow.headers });
  });

  it("row values take precedence over the env tuple, and its id admits fallbacks", () => {
    process.env.OPENOMNI_MODEL_API_KEY = "sk-env";
    process.env.OPENOMNI_MODEL_BASE_URL = "http://env.invalid/v1";
    process.env.OPENOMNI_MODEL_HEADERS = JSON.stringify({ "x-tenant": "env", "x-extra": "kept" });
    process.env.OPENOMNI_MODEL_FALLBACKS = "gateway/gw-2";
    process.env.GATEWAY_API_KEY = "sk-row";
    useRows(JSON.stringify({ providers: [gatewayRow] }));

    expect(loadConfig().model).toEqual({
      provider: "gateway",
      id: "gw-1",
      apiKey: "sk-row",
      baseUrl: gatewayRow.baseUrl,
      headers: { "x-tenant": "acme", "x-extra": "kept" },
      fallbacks: [{ provider: "gateway", id: "gw-2" }],
    });
  });

  it.each([
    ["an npm package outside the bundled two", JSON.stringify({ providers: [{ ...gatewayRow, npm: "@ai-sdk/other" }] }), "unsupported_npm"],
    ["a non-JSON file", "{ nope", "invalid_json"],
  ])("refuses boot typed on %s", (_name, body, reason) => {
    process.env.OPENOMNI_MODEL_API_KEY = "sk-env";
    useRows(body);

    expect(() => loadConfig()).toThrow(expect.objectContaining({
      name: "OpenOmniConfigurationError",
      data: expect.objectContaining({ code: "invalid_providers_file", message: expect.stringContaining(`OPENOMNI_PROVIDERS_PATH ${reason}`) }),
    }));
  });
});
