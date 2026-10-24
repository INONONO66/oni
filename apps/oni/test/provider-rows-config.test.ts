import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { resolveAuthFilePath } from "@oni/llm";
import { loadConfig, modelTransport } from "../src/config";

const KEYS = [
  "ONI_PROVIDERS_PATH",
  "ONI_MODEL_PROVIDER",
  "ONI_MODEL_ID",
  "ONI_MODEL_API_KEY",
  "ONI_MODEL_BASE_URL",
  "ONI_MODEL_HEADERS",
  "ONI_MODEL_FALLBACKS",
  "GATEWAY_API_KEY",
  "ONI_AUTH_FILE",
] as const;

let saved: Record<string, string | undefined>;
let directory: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  directory = mkdtempSync(join(tmpdir(), "provider-rows-config-"));
  process.env.ONI_MODEL_PROVIDER = "gateway";
  process.env.ONI_MODEL_ID = "gw-1";
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
  process.env.ONI_PROVIDERS_PATH = path;
}

const gatewayRow = {
  id: "gateway",
  npm: "@ai-sdk/openai",
  baseUrl: "http://127.0.0.1:9/v1",
  headers: { "x-tenant": "acme" },
  auth: "GATEWAY_API_KEY",
};

describe("ONI_PROVIDERS_PATH", () => {
  it("resolves the same model config as the equivalent env tuple", () => {
    process.env.ONI_MODEL_API_KEY = "sk-gw";
    process.env.ONI_MODEL_BASE_URL = gatewayRow.baseUrl;
    process.env.ONI_MODEL_HEADERS = JSON.stringify(gatewayRow.headers);
    const fromEnv = loadConfig().model;

    for (const key of ["ONI_MODEL_API_KEY", "ONI_MODEL_BASE_URL", "ONI_MODEL_HEADERS"]) delete process.env[key];
    process.env.GATEWAY_API_KEY = "sk-gw";
    useRows(JSON.stringify({ providers: [gatewayRow] }));
    const fromRows = loadConfig().model;

    expect(fromRows).toEqual(fromEnv);
    expect(modelTransport(fromRows)).toEqual({ baseUrl: gatewayRow.baseUrl, headers: gatewayRow.headers });
  });

  it("row values take precedence over the env tuple, and its id admits fallbacks", () => {
    process.env.ONI_MODEL_API_KEY = "sk-env";
    process.env.ONI_MODEL_BASE_URL = "http://env.invalid/v1";
    process.env.ONI_MODEL_HEADERS = JSON.stringify({ "x-tenant": "env", "x-extra": "kept" });
    process.env.ONI_MODEL_FALLBACKS = "gateway/gw-2";
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

  it("hands speech-to-text the rows only when one names a transcription model", () => {
    process.env.GATEWAY_API_KEY = "sk-row";
    useRows(JSON.stringify({ providers: [gatewayRow] }));
    expect(loadConfig().model.transcriptionRows).toBeUndefined();

    const sttRow = { ...gatewayRow, npm: "@ai-sdk/openai" as const, transcription: "whisper-large" };
    useRows(JSON.stringify({ providers: [sttRow] }));
    const config = loadConfig();
    expect(config.model.transcriptionRows).toEqual([sttRow]);
  });

  it("uses one auth path resolution for chat and speech-to-text with a padded override", () => {
    process.env.ONI_MODEL_API_KEY = "sk-test";
    process.env.ONI_AUTH_FILE = ` ${join(directory, "auth.json")} `;
    const config = loadConfig();
    const chatPath = resolveAuthFilePath();
    const sttPath = resolveAuthFilePath();
    expect(config).not.toHaveProperty("authFilePath");
    expect(chatPath).toBe(resolve(process.env.ONI_AUTH_FILE));
    expect(isAbsolute(sttPath)).toBe(true);
    expect(sttPath).toBe(chatPath);
  });

  it.each([
    ["an npm package outside the bundled two", JSON.stringify({ providers: [{ ...gatewayRow, npm: "@ai-sdk/other" }] }), "unsupported_npm"],
    ["a non-JSON file", "{ nope", "invalid_json"],
  ])("refuses boot typed on %s", (_name, body, reason) => {
    process.env.ONI_MODEL_API_KEY = "sk-env";
    useRows(body);

    expect(() => loadConfig()).toThrow(expect.objectContaining({
      name: "OniConfigurationError",
      data: expect.objectContaining({ code: "invalid_providers_file", message: expect.stringContaining(`ONI_PROVIDERS_PATH ${reason}`) }),
    }));
  });
});
