import { afterEach, beforeEach, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCatalog } from "./model-loader";

/** Registers per-test catalog/auth isolation and rejects unexpected network use. */
export function usePrivateCatalog(): void {
  let directory: string;
  let savedEnv: NodeJS.ProcessEnv;
  let savedFetch: typeof fetch;
  const network = mock(() => Promise.reject(new Error("unexpected network request")));

  beforeEach(() => {
    savedEnv = { ...process.env };
    savedFetch = globalThis.fetch;
    directory = mkdtempSync(join(tmpdir(), "provider-catalog-"));
    process.env.OPENOMNI_MODELS_PATH = join(directory, "models.json");
    process.env.OPENOMNI_AUTH_FILE = join(directory, "auth.json");
    process.env.OPENOMNI_DISABLE_MODELS_FETCH = "1";
    writeFileSync(process.env.OPENOMNI_AUTH_FILE, "{}");
    writeFileSync(
      process.env.OPENOMNI_MODELS_PATH,
      JSON.stringify({
        anthropic: {
          id: "anthropic",
          name: "Fixture Anthropic",
          env: [],
          npm: "@ai-sdk/anthropic",
          models: { "fixture-claude": { id: "fixture-claude", name: "Fixture Claude" } },
        },
        openai: {
          id: "openai",
          name: "Fixture OpenAI",
          env: [],
          npm: "@ai-sdk/openai",
          models: { "fixture-gpt": { id: "fixture-gpt", name: "Fixture GPT" } },
        },
      }),
    );
    network.mockClear();
    globalThis.fetch = Object.assign(network, { preconnect: savedFetch.preconnect });
    resetCatalog();
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    resetCatalog();
    process.env = savedEnv;
    rmSync(directory, { recursive: true, force: true });
    expect(network).not.toHaveBeenCalled();
  });
}
