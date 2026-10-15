import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { makeLlmService } from "../../src";
import { resolveProviderRows } from "../../src/model/loader";
import { BUNDLED_ROWS, readProviderRows } from "../../src/provider/rows";
import { getLanguage } from "../../src/provider/sdk";
import { usePrivateCatalog } from "../helpers/catalog";
import { fixedNow } from "../helpers/fixtures";
import { runEffect } from "../helpers/native";
import { captureRequest } from "../helpers/provider-fetch";

const AUTH_FILE = "/nonexistent/openomni-test/auth.json";
usePrivateCatalog();

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "provider-rows-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function rowsFile(body: string): string {
  const path = join(directory, "providers.json");
  writeFileSync(path, body);
  return path;
}

const gateway = {
  id: "gateway",
  npm: "@ai-sdk/openai",
  baseUrl: "http://127.0.0.1:9/v1",
  headers: { "x-tenant": "acme" },
  auth: "GATEWAY_API_KEY",
  api: "chat",
};

describe("provider rows file", () => {
  test("a row outside the catalog resolves to a model that sends its endpoint, headers and API surface", async () => {
    const rows = readProviderRows(rowsFile(JSON.stringify({ providers: [gateway] })));
    const model = await runEffect(makeLlmService(AUTH_FILE, rows).resolveModel({ provider: "gateway", id: "gw-1" }, fixedNow));
    expect(model).toEqual({
      id: "gw-1", providerID: "gateway", name: "gw-1",
      api: { id: "gw-1", npm: "@ai-sdk/openai", url: "http://127.0.0.1:9/v1", style: "chat", headers: { "x-tenant": "acme" } },
    });
    const { url, headers } = await captureRequest(
      () => getLanguage(model, { type: "api", key: "sk-gw" }).doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
      { id: "c1", object: "chat.completion", created: 0, model: "gw-1", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
    );
    expect(url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(headers.get("x-tenant")).toBe("acme");
  });

  test("a configured row replaces the bundled row of the same id; others stay bundled", async () => {
    const service = makeLlmService(AUTH_FILE, [{ id: "openai", npm: "@ai-sdk/openai", api: "chat" }]);
    expect((await runEffect(service.resolveModel({ provider: "openai", id: "fixture-gpt" }, fixedNow))).api?.style).toBe("chat");
    expect((await runEffect(service.resolveModel({ provider: "anthropic", id: "fixture-claude" }, fixedNow))).api?.headers)
      .toEqual(BUNDLED_ROWS[0]?.headers);
  });

  test("a catalog provider's missing model still refuses typed under a row", async () => {
    const service = makeLlmService(AUTH_FILE, []);
    expect(await runEffect(Effect.flip(service.resolveModel({ provider: "openai", id: "absent" }, fixedNow)))).toMatchObject({
      _tag: "ModelResolutionError", reason: "model_not_found",
    });
  });

  test.each([
    ["unsupported_npm", JSON.stringify({ providers: [{ ...gateway, npm: "@ai-sdk/other" }] })],
    ["invalid_rows", JSON.stringify({ providers: [gateway, gateway] })],
    ["invalid_json", "{ not json"],
  ])("a malformed file refuses with reason %s", (reason, body) => {
    const path = rowsFile(body);
    expect(() => readProviderRows(path)).toThrow(expect.objectContaining({ _tag: "ProviderRowsError", reason, path }));
  });

  test("an unreadable path refuses typed; an unset path is no configured rows", () => {
    const path = join(directory, "missing.json");
    expect(() => resolveProviderRows({ OPENOMNI_PROVIDERS_PATH: path })).toThrow(
      expect.objectContaining({ _tag: "ProviderRowsError", reason: "unreadable" }),
    );
    expect(resolveProviderRows({})).toEqual([]);
  });
});
