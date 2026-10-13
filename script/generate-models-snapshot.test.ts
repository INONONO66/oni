import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlainValueSchema } from "../packages/protocol/src/json.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const catalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    api: "https://api.anthropic.com",
    doc: "dropped by the projection",
    models: {
      "claude-example": {
        id: "claude-example",
        name: "Claude Example",
        family: "claude",
        release_date: "2026-01-01",
        status: "stable",
        limit: { context: 200_000, output: 8192 },
        provider: { npm: "@ai-sdk/anthropic" },
        cost: { input: 3 },
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: {
      "gpt-example": { id: "gpt-example", name: "GPT Example" },
    },
  },
  ignored: { id: "ignored", name: "Not bundled", env: [], npm: "x", models: {} },
};

test("projects the bundled providers of the models.dev catalog into the snapshot", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json(catalog) });
  const previousUrl = process.env.MODELS_DEV_URL;
  process.env.MODELS_DEV_URL = server.url.toString();
  const root = mkdtempSync(join(tmpdir(), "models-snapshot-"));
  roots.push(root);
  const cwd = process.cwd();
  process.chdir(root);
  const logs: string[] = [];
  const log = spyOn(console, "log").mockImplementation((message: string) => {
    logs.push(message);
  });
  try {
    const { main } = await import("./generate-models-snapshot");
    await main();
  } finally {
    log.mockRestore();
    process.chdir(cwd);
    if (previousUrl === undefined) {
      delete process.env.MODELS_DEV_URL;
    } else {
      process.env.MODELS_DEV_URL = previousUrl;
    }
    server.stop(true);
  }
  const written = PlainValueSchema.parse(JSON.parse(
    readFileSync(join(root, "packages/llm/src/model/models-snapshot.json"), "utf8"),
  ));
  expect(written).toEqual({
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      npm: "@ai-sdk/anthropic",
      api: "https://api.anthropic.com",
      models: {
        "claude-example": {
          id: "claude-example",
          name: "Claude Example",
          family: "claude",
          release_date: "2026-01-01",
          status: "stable",
          limit: { context: 200_000 },
          provider: { npm: "@ai-sdk/anthropic" },
        },
      },
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      npm: "@ai-sdk/openai",
      models: { "gpt-example": { id: "gpt-example", name: "GPT Example" } },
    },
  });
  expect(logs).toEqual([
    "[generate-models-snapshot] wrote packages/llm/src/model/models-snapshot.json (2 providers)",
  ]);
});

test.each([
  ["upstream failure", 503, catalog, "503"],
  ["missing provider", 200, { anthropic: catalog.anthropic }, "openai"],
])("refuses %s without writing a snapshot", async (_name, status, payload, message) => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json(payload, { status }) });
  const root = mkdtempSync(join(tmpdir(), "models-snapshot-error-"));
  roots.push(root);
  try {
    const result = Bun.spawn([process.execPath, join(import.meta.dir, "generate-models-snapshot.ts")], {
      cwd: root,
      env: { ...process.env, MODELS_DEV_URL: server.url.toString() },
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([result.exited, new Response(result.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(message);
    expect(await Bun.file(join(root, "packages/llm/src/model/models-snapshot.json")).exists()).toBe(false);
  } finally {
    server.stop(true);
  }
});

test.each([
  ["unavailable catalog", 503, catalog, "503"],
  ["incomplete provider", 200, { anthropic: catalog.anthropic }, "openai"],
])("in-process projection refuses %s without a snapshot", async (_name, status, payload, message) => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json(payload, { status }) });
  const previousUrl = process.env.MODELS_DEV_URL;
  process.env.MODELS_DEV_URL = server.url.toString();
  const root = mkdtempSync(join(tmpdir(), "models-snapshot-in-process-"));
  roots.push(root);
  const cwd = process.cwd();
  process.chdir(root);
  const errors: string[] = [];
  const error = spyOn(console, "error").mockImplementation((text: string) => {
    errors.push(text);
  });
  try {
    const { main } = await import("./generate-models-snapshot");
    expect(await main()).toBe(1);
    expect(errors.join("")).toContain(message);
    expect(await Bun.file(join(root, "packages/llm/src/model/models-snapshot.json")).exists()).toBe(false);
  } finally {
    error.mockRestore();
    process.chdir(cwd);
    if (previousUrl === undefined) delete process.env.MODELS_DEV_URL;
    else process.env.MODELS_DEV_URL = previousUrl;
    server.stop(true);
  }
});
