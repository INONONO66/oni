import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Core, Bundle } from "@openomni/agent";
import { makeLlmService } from "@openomni/llm";
const defineTool = Core.defineTool;
const eraseTool = Core.eraseTool;
const Llm = Core.Llm;
import { sessionFilePath } from "../src/composition/cluster-runtime";
import { planeOf } from "./helpers/ledger";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { gatewayRuntime, runAppEffect } from "../src/gateway";
import { residentSuite } from "./helpers/resident-suite";
import { auditBundle, composedHolder, ProviderRequest, providerResponse } from "./helpers/bundle-fixture";
import { testToolsBundle } from "./helpers/app-fixture";
import { nextResidentTurn } from "./helpers/resident-turn";
import { eventSignal } from "./helpers/event-signal";
import { Bus, newTraceId } from "./helpers/bus";

/** The fixture provider is reached over `baseUrl`; no credential file is read on this path. */
const ABSENT_AUTH_FILE = "/nonexistent/openomni-test/auth.json";

const suite = residentSuite();
const echo = (name: string, execute: (text: string) => Promise<string>) => eraseTool(defineTool({
  name, category: "query", description: "Echo admitted input", input: z.object({ text: z.string() }), output: z.string(),
  visibility: { model: ["resident"], cell: ["resident"] }, execute: ({ text }) => execute(text), render: (_input, output) => output,
}));

for (const enabled of [false, true]) test(`one AppLive bundle argument controls real WS JSONL observation (${enabled})`, async () => {
  const directory = suite.tempDir("app-observer-");
  const path = join(directory, "audit.jsonl");
  const audit = auditBundle(path);
  let calls = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    ProviderRequest.parse(await request.json());
    return providerResponse(++calls === 1 ? { name: "echo", input: { text: "observed" } } : undefined);
  } });
  suite.defer(() => provider.stop(true));
  const config = suite.config("app-observer-db-", { wsToken: "fixture", compactionSummarizer: false,
    model: { provider: "anthropic", id: "fixture", apiKey: "fixture", baseUrl: `http://127.0.0.1:${provider.port}/v1` } });
  const echoTool = echo("echo", async (text) => text);
  const runtime = gatewayRuntime({ observations: Bus, catalogPath: config.catalogPath, sessionsDir: config.sessionsDir,
    composed: composedHolder({ bundles: [...(enabled ? [audit.contract] : []), testToolsBundle([echoTool])] }),
    llm: Layer.succeed(Llm, { ...makeLlmService(ABSENT_AUTH_FILE), resolveModel: () => Effect.succeed({ providerID: "anthropic", id: "fixture", name: "fixture", api: { npm: "@ai-sdk/anthropic" } }) }),
  });
  const app = await suite.boot({ config, runtime });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, ["auth", "fixture"]);
  const reply = nextResidentTurn(plane);
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "echo" }));
  await reply;
  const row = plane.listSessions().find((row) => row.id !== "gateway-ingress");
  if (row === undefined) throw new Error("missing resident");
  const hooks = sessionTree(row.id, plane.sessionStore(row.id).actions).filter((action) => action.kind === "policy.decision").map((action) => action.intent.value);
  expect(hooks).toEqual(expect.arrayContaining([expect.objectContaining({ hook: "tool.pre", op: "echo" }), expect.objectContaining({ hook: "tool.post", op: "echo" })]));
  const sessionsDir = config.sessionsDir;
  if (sessionsDir === undefined) throw new Error("suite config is missing sessionsDir");
  const db = new Database(sessionFilePath(sessionsDir, row.id), { readonly: true });
  try { expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM action WHERE kind = 'policy.decision'").get()?.count).toBeGreaterThan(0); }
  finally { db.close(); }
  expect(existsSync(path)).toBe(enabled);
  if (enabled) {
    const entries = readFileSync(path, "utf8").trim().split("\n").map((line) => z.object({ event: z.string(), data: z.object({ sessionId: z.string() }) }).parse(JSON.parse(line)));
    expect(entries.map((entry) => entry.event)).toEqual(expect.arrayContaining(["tool.execution.started", "tool.execution.completed"]));
    expect(entries.every((entry) => entry.data.sessionId === row.id)).toBe(true);
  }
  await app.stop();
  expect(audit.closed.sort()).toEqual(audit.acquired.sort());
  expect(calls).toBe(2);
});

test("a held WS generation keeps its catalog and transformer while public tools.add selects the next generation", async () => {
  const path = join(suite.tempDir("held-observer-"), "audit.jsonl");
  const audit = auditBundle(path);
  const entered = eventSignal<void>("g1 body entered");
  const release = Promise.withResolvers<void>();
  const seen: string[] = [];
  const base = echo("echo", async (text) => { seen.push(text); entered.resolve(); await release.promise; return text; });
  const demo = echo("demo__echo", async (text) => { seen.push(text); return text; });
  // #1255 P3: the demo bundle is a composed CONTRACT — its transformer is a
  // registered handler and its rewrite row rides the frozen #1251 gate shape.
  const definition = Bundle.define({ name: "demo", requires: [], tools: [demo],
    handlers: { "demo/redact-home": { apply: () => ({ text: "redacted" }) } },
    rows: [{
      id: "demo/tool.pre#1", on: "tool.pre", order: 1000,
      when: { op: "echo" }, do: "rewrite", how: { ref: "demo/redact-home", params: { fields: ["text"] } },
    }] });
  const offered: string[][] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const body = ProviderRequest.parse(await request.json());
    offered.push(body.tools?.map((tool) => tool.name) ?? []);
    const name = offered.length === 1 ? "echo" : offered.length === 3 ? "demo__echo" : undefined;
    return providerResponse(name === undefined ? undefined : { name, input: { text: "/home/private" } });
  } });
  suite.defer(() => provider.stop(true));
  const config = suite.config("app-bundle-swap-", { wsToken: "fixture", compactionSummarizer: false,
    model: { provider: "anthropic", id: "fixture", apiKey: "fixture", baseUrl: `http://127.0.0.1:${provider.port}/v1` } });
  const runtime = gatewayRuntime({ observations: Bus, catalogPath: config.catalogPath, sessionsDir: config.sessionsDir, composed: composedHolder({ bundles: [audit.contract, definition, testToolsBundle([base])] }),
    llm: Layer.succeed(Llm, { ...makeLlmService(ABSENT_AUTH_FILE), resolveModel: () => Effect.succeed({ providerID: "anthropic", id: "fixture", name: "fixture", api: { npm: "@ai-sdk/anthropic" } }) }),
  });
  const app = await suite.boot({ config, runtime });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, ["auth", "fixture"]);
  const first = nextResidentTurn(plane);
  try {
    ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "hold" }));
    await entered.promise;
    const row = plane.listSessions().find((row) => row.id !== "gateway-ingress");
    if (row === undefined) throw new Error("missing resident");
    const handle = app.sessions.get(row.id);
    if (handle === undefined) throw new Error("missing live session");
    const retired = eventSignal<void>("g1 observer finalized");
    void audit.whenClosed(2).then(retired.resolve, retired.reject);
    // The composed demo face is already on from materialize (#1255); an
    // empty add still selects the next generation — the pinning under test.
    expect(await runAppEffect(runtime, handle.tools.add([]))).toMatchObject({ generation: 2 });
    expect(audit.closed).not.toContain(2);
    release.resolve();
    await first;
    await retired.promise;
    const second = nextResidentTurn(plane);
    ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "next" }));
    await second;
    // The composed bundle's face is on from materialize (#1255): every
    // request offers it; the held turn still executes on its g1 catalog.
    expect(offered.every((names) => names.includes(demo.name))).toBe(true);
    expect(seen).toEqual(["redacted", "/home/private"]);
    expect(audit.acquired).toEqual([1, 2, 3]);
    const observed = readFileSync(path, "utf8").trim().split("\n").map((line) => z.object({ acquisition: z.number(), data: z.object({ toolName: z.string() }) }).parse(JSON.parse(line)));
    expect(observed.filter((entry) => entry.data.toolName === "echo").map((entry) => entry.acquisition)).toEqual([2, 2]);
    expect(observed.filter((entry) => entry.data.toolName === "demo__echo").map((entry) => entry.acquisition)).toEqual([3, 3]);
    const actions = sessionTree(row.id, plane.sessionStore(row.id).actions);
    expect(actions.map((action) => action.intent.value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "echo", originalArgs: { text: "/home/private" }, value: { text: "redacted" } }),
      expect.objectContaining({ hook: "tool.pre", ref: "demo/redact-home", transforms: [{ ruleId: "demo/tool.pre#1", ref: "demo/redact-home" }] }),
    ]));
  } finally { release.resolve(); await first; }
});
