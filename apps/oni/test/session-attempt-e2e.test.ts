import { expect, test } from "bun:test";
import { newTraceId } from "./helpers/bus";
import { runEffect } from "./helpers/effect";
import { Auth } from "@oni/llm";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { sessionFilePath } from "../src/composition/cluster-runtime";
import { planeOf } from "./helpers/ledger";
import { residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";

import { messageStart, messageEnd, sseResponse } from "./helpers/anthropic-sse";

const suite = residentSuite();

/** Boots the app on `config`, opens the owner socket, and awaits one resident turn. */
async function bootAndAwaitTurn(config: ReturnType<typeof suite.config>, text: string) {
  const app = await suite.boot({ config });
  const plane = await planeOf(app.runtime);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "token"]);
  const reply = nextResidentTurn(plane);
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text }));
  await reply;
  return plane;
}
function stream(text: string, fail: boolean, tool: boolean): Response {
  const frames = [
    messageStart("attempt", "claude-opus-4-5", 8),
    {
      type: "content_block_start",
      index: 0,
      content_block: tool
        ? { type: "tool_use", id: "call", name: "provision", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: tool
        ? {
            type: "input_json_delta",
            partial_json: JSON.stringify({ operation: { op: "status", args: {} } }),
          }
        : { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    ...(fail
      ? [{ type: "error", error: { type: "overloaded_error", message: "overloaded" } }]
      : messageEnd("end_turn", 3)),
  ];
  return sseResponse(frames);
}

for (const visible of ["none", "text", "tool"] as const) {
  test(`real SSE ${visible} visibility has exact provider invocation and durable child topology`, async () => {
    let requests = 0;
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1;
        if (visible === "none" && requests < 3)
          return Response.json(
            { type: "error", error: { type: "overloaded_error", message: "overloaded" } },
            { status: 529, headers: { "retry-after-ms": "0" } },
          );
        return stream("visible", visible !== "none", visible === "tool");
      },
    });
    suite.defer(() => provider.stop(true));
    const config = suite.config("937-real-attempt-", {
      wsToken: "token",
      compactionSummarizer: false,
      model: {
        provider: "anthropic",
        id: "claude-opus-4-5",
        apiKey: "primary-key",
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      },
    });
    const plane = await bootAndAwaitTurn(config, "attempt");
    const sessionId = plane.listSessions().filter((row) => row.id !== "gateway-ingress")[0]?.id;
    if (sessionId === undefined) throw new Error("missing session");
    const sessionsDir = config.sessionsDir;
    if (sessionsDir === undefined) throw new Error("suite config is missing sessionsDir");
    const db = new Database(sessionFilePath(sessionsDir, sessionId), { readonly: true });
    try {
      const parents = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM action WHERE session_id=? AND kind='llm' AND json_extract(intent,'$.phase')='intent' AND json_extract(intent,'$.attempt') IS NULL",
        )
        .all(sessionId);
      const attempts = db
        .query<{ parent_id: string | null }, [string]>(
          "SELECT parent_id FROM action WHERE session_id=? AND kind='llm' AND json_extract(intent,'$.phase')='intent' AND json_extract(intent,'$.attempt') IS NOT NULL ORDER BY ordinal",
        )
        .all(sessionId);
      expect(parents).toHaveLength(1);
      expect(attempts).toHaveLength(visible === "none" ? 3 : 1);
      const parent = parents[0];
      expect(attempts).toEqual(
        Array.from({ length: attempts.length }, () => ({ parent_id: parent?.id ?? null })),
      );
      expect(requests).toBe(visible === "none" ? 3 : 1);
      // Durable retry schedule (#1254 chain): each backoff committed a live
      // `alarm{arm, purpose: retry}` row carrying the attempt; the settle that
      // follows a wait is the next armSeq with `at: null`, never a delete.
      const retryAlarms = db
        .query(
          "SELECT json_extract(intent,'$.payload.attempt') AS attempt FROM action WHERE session_id=? AND kind='alarm' AND json_extract(intent,'$.op')='arm' AND json_extract(intent,'$.purpose')='retry' AND json_extract(intent,'$.at') IS NOT NULL ORDER BY ordinal",
        )
        .all(sessionId);
      expect(retryAlarms).toEqual(visible === "none" ? [{ attempt: 1 }, { attempt: 2 }] : []);
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM action a WHERE a.kind='llm' AND json_extract(a.effect,'$.evidence.failures[0].usage.inputTokens') IS NOT NULL AND EXISTS (SELECT 1 FROM action p WHERE p.id=a.parent_id AND json_extract(p.intent,'$.attempt') IS NOT NULL)",
          )
          .get(),
      ).toEqual({ count: visible === "none" ? 2 : 1 });
      if (visible !== "none")
        expect(plane.openKernel(sessionId).getSnapshot(sessionId).turns[0]?.terminal?.kind).toBe("error");
      console.log(
        "937 SSE attempt",
        JSON.stringify({ visible, requests, retryAlarms, parents, attempts }),
      );
    } finally {
      db.close();
      await suite.cleanup();
    }
  });
}

test("real cross-provider fallback sends only the fallback's stored credential", async () => {
  const authorization: { path: string; key: string | null }[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      authorization.push({
        path: new URL(request.url).pathname,
        key: request.headers.get("authorization") ?? request.headers.get("x-api-key"),
      });
      if (authorization.length === 1)
        return Response.json(
          { type: "error", error: { type: "overloaded_error", message: "overloaded" } },
          { status: 529, headers: { "retry-after-ms": "0" } },
        );
      const item = {
        id: "message",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "fallback completed", annotations: [] }],
        status: "completed",
      };
      return new Response(
        [
          {
            type: "response.created",
            response: { id: "fallback", created_at: 1, model: "gpt-4o" },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, content: [], status: "in_progress" },
          },
          {
            type: "response.output_text.delta",
            item_id: "message",
            output_index: 0,
            content_index: 0,
            delta: "fallback completed",
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "fallback",
              created_at: 1,
              model: "gpt-4o",
              status: "completed",
              output: [item],
              usage: {
                input_tokens: 4,
                output_tokens: 2,
                total_tokens: 6,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            },
          },
        ]
          .map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  suite.defer(() => provider.stop(true));
  const config = suite.config("937-fallback-auth-", {
    wsToken: "token",
    compactionSummarizer: false,
    model: {
      provider: "anthropic",
      id: "claude-opus-4-5",
      apiKey: "primary-key",
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      fallbacks: [{ provider: "openai", id: "gpt-4o" }],
    },
  });
  const catalogPath = config.catalogPath;
  if (catalogPath === undefined) throw new Error("suite config is missing catalogPath");
  const old = process.env.ONI_AUTH_FILE;
  process.env.ONI_AUTH_FILE = join(catalogPath, "..", "auth.json");
  suite.defer(() => {
    if (old === undefined) delete process.env.ONI_AUTH_FILE;
    else process.env.ONI_AUTH_FILE = old;
  });
  await runEffect(Auth.set("openai", { type: "api", key: "fallback-key" }, { id: () => "tmp-fallback", authFilePath: join(catalogPath, "..", "auth.json") }));
  const plane = await bootAndAwaitTurn(config, "fallback");
  expect(authorization.map((request) => request.key)).toEqual([
    "primary-key",
    "Bearer fallback-key",
  ]);
  expect(authorization[1]?.path).toBe("/v1/responses");
  const row = plane.listSessions().filter((row) => row.id !== "gateway-ingress")[0];
  if (row === undefined) throw new Error("missing fallback session");
  const snapshot = plane.openKernel(row.id).getSnapshot(row.id);
  expect(snapshot.turns[0]?.terminal?.kind).toBe("result");
  expect(snapshot.turns[0]?.messages.at(-1)?.text).toBe("fallback completed");
  expect(existsSync(catalogPath)).toBe(true);
  console.log("937 fallback transport", JSON.stringify(authorization));
  await suite.cleanup();
});
