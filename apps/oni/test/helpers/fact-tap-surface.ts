import { sessionTree } from "../../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "@oni/agent";
import { run } from "@oni/llm";
const defineTool = Core.defineTool;
const eraseTool = Core.eraseTool;
import { Bus, newTraceId } from "./bus";
import { LlmCall, type Message, type Tool } from "@oni/protocol";
import { z } from "zod";
import { appFixture, testToolsBundle } from "./app-fixture";
import { closeSocket, openSocket } from "./ws";
import { sessionFilePath } from "../../src/composition/cluster-runtime";
import { planeOf } from "./ledger";
import { nextResidentTurn } from "./resident-turn";

import { messageStart, messageEnd } from "./anthropic-sse";
import { testMachinesPlane } from "./self-machine";

// A local provider speaks real Anthropic SSE to the installed SDK, not a run/SDK mock.
function response(tool: boolean): Response {
  const frames = [
    messageStart("provider-message", "fixture", tool ? 5 : 11),
    {
      type: "content_block_start",
      index: 0,
      content_block: tool
        ? { type: "tool_use", id: "paired", name: "lookup", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: tool
        ? { type: "input_json_delta", partial_json: "{}" }
        : { type: "text_delta", text: "retained reply" },
    },
    { type: "content_block_stop", index: 0 },
    ...messageEnd(tool ? "tool_use" : "end_turn", tool ? 7 : 13),
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(
            new TextEncoder().encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`),
          );
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const directory = mkdtempSync(join(tmpdir(), "oni-967-fact-tap-"));
const catalogPath = join(directory, "catalog.sqlite");
const sessionsDir = join(directory, "sessions");
let requests = 0;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/messages");
    assert.equal(request.headers.get("x-api-key"), "fixture-key");
    const body = await request.text();
    z.object({ stream: z.literal(true) }).parse(JSON.parse(body));
    requests += 1;
    if (requests === 2) {
      return Response.json(
        { type: "error", error: { type: "overloaded_error", message: "retry fixture" } },
        {
          status: 529,
          headers: { "retry-after-ms": "1" },
        },
      );
    }
    return response(requests === 1);
  },
});
const providerPort = provider.port;
const model: Core.ResolvedModel = {
  id: "fixture",
  name: "fixture",
  providerID: "anthropic",
  api: { npm: "@ai-sdk/anthropic", url: `http://127.0.0.1:${provider.port}/v1` },
};
const events = Bus;
const messages: Message.WithParts[] = [];
const calls: Tool.Call[] = [];
const results: Tool.Result[] = [];
let stopApp: (() => Promise<void>) | undefined;
let ws: WebSocket | undefined;
let appPort: number | undefined;
let unsubscribe: (() => void) | undefined;
try {
  // Given: actual provider calls bill one tool step, fail the next request, then retry.
  const billed = { input: 0, output: 0 };
  unsubscribe = events.subscribe(LlmCall.Events.Completed, (event) => {
    billed.input += event.inputTokens;
    billed.output += event.outputTokens;
  });
  // When: the production app calls the same real SDK through its configured transport.
  const app = await appFixture({
    config: {
      catalogPath,
      sessionsDir,
      machineGenerationsPath: join(directory, "machines", "generations.json"),
      host: "127.0.0.1",
      wsPort: 0,
      wsToken: "fixture-token",
      kek: { kind: "locked", reason: "no vault key in this fixture" },
      machines: testMachinesPlane(),
      compactionSummarizer: false,
      model: {
        provider: "anthropic",
        id: "fixture",
        apiKey: "fixture-key",
        baseUrl: model.api?.url,
      },
    },
    bundles: [testToolsBundle([
      eraseTool(
        defineTool({
          name: "lookup",
          description: "Fixture lookup",
          category: "query",
          visibility: { model: ["resident"], cell: [] },
          input: z.object({}),
          output: z.string(),
          execute: async () => "42",
          render: (_input, value) => value,
        }),
      ),
    ])],
    llm: {
      resolveModel: () => Effect.succeed(model),
      run: (input, sink) =>
        run({ ...input, authFilePath: "/nonexistent/oni-test/auth.json" }, {
          onMessage(message) {
            messages.push(message);
            sink.onMessage(message);
          },
          onToolCall(call) {
            calls.push(call);
            sink.onToolCall(call);
          },
          onToolResult(result) {
            results.push(result);
            sink.onToolResult(result);
          },
        }),
    },
  });
  stopApp = app.stop;
  appPort = app.port;
  const plane = await planeOf(app.runtime);
  ws = await openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "fixture-token"]);
  const terminal = nextResidentTurn(plane, 5000);
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "967 input" }));
  const reply = await terminal;

  // Then: the committed turn retains the provider reply without external dispatch.
  assert.equal(reply.text, "retained reply");
  assert.equal(requests, 3);
  assert.deepEqual(billed, { input: 16, output: 20 });
  assert.deepEqual(calls, [{ id: "paired", tool: "lookup", input: {} }]);
  assert.deepEqual(results, []); // Provider I/O no longer fabricates or executes tool results.
  const terminals = messages.filter(
    (message) => message.info.role === "assistant" && message.info.finish !== undefined,
  );
  assert.deepEqual(
    terminals.map((message) => (message.info.role === "assistant" ? message.info.finish : null)),
    ["stop", "error", "stop"],
  );
  assert.equal(messages[0]?.info.role === "assistant" ? messages[0].info.tokens.input : -1, 0);
  assert.equal(terminals[0]?.parts.find((part) => part.type === "tool")?.state.status, "pending");
  assert.deepEqual(
    messages
      .at(-1)
      ?.parts.filter((part) => part.type === "text")
      .map((part) => part.text),
    ["retained reply"],
  );
  console.log("967 provider", JSON.stringify({ requests, billed, calls, results, terminals }));
  const rows = plane.listSessions().filter((row) => row.id !== "gateway-ingress");
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  const toolResults = sessionTree(row.id, plane.sessionStore(row.id).actions)
    .filter((action) => action.kind === "tool")
    .flatMap((action) => {
      const parsed = z
        .object({
          phase: z.literal("result"),
          callId: z.string(),
          result: z.object({ status: z.literal("success"), output: z.string() }),
        })
        .safeParse(action.effect.value);
      return parsed.success ? [parsed.data] : [];
    });
  assert.deepEqual(toolResults, [
    { phase: "result", callId: "paired", result: { status: "success", output: "42" } },
  ]);
  const snapshot = plane.openKernel(row.id).getSnapshot(row.id);
  assert.equal(snapshot.state, "idle");
  assert.deepEqual(snapshot.turns.at(-1)?.messages, [
    { role: "user", text: "967 input" },
    { role: "assistant", text: "retained reply" },
  ]);
  assert.equal(snapshot.turns.at(-1)?.terminal?.kind, "result");
  const db = new Database(sessionFilePath(sessionsDir, row.id), { readonly: true });
  try {
    const actions = db
      .query<{ session_id: string; kind: string; ordinal: number }, []>(
        "SELECT session_id, kind, ordinal FROM action ORDER BY ordinal",
      )
      .all();
    assert.ok(actions.length > 0);
    assert.deepEqual(
      db
        .query<{ table: string; rowid: number; parent: string; fkid: number }, []>(
          "PRAGMA foreign_key_check",
        )
        .all(),
      [],
    );
    console.log(
      "967 app SQLite",
      JSON.stringify({ reply, requests, appPort, catalogPath, actions, turns: snapshot.turns }),
    );
  } finally {
    db.close();
  }
} finally {
  unsubscribe?.();
  try {
    if (ws !== undefined) await closeSocket(ws);
  } finally {
    try {
      await stopApp?.();
    } finally {
      await provider.stop(true);
      rmSync(directory, { recursive: true, force: true });
      for (const port of [providerPort, appPort]) {
        if (port === undefined) continue;
        const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
        await probe.stop(true);
      }
      assert.equal(existsSync(directory), false);
      if (ws !== undefined) assert.equal(ws.readyState, WebSocket.CLOSED);
      console.log(
        "967 cleanup",
        JSON.stringify({
          appPort,
          providerPort,
          directory,
          directoryExists: existsSync(directory),
          socketState: ws?.readyState,
        }),
      );
    }
  }
}
