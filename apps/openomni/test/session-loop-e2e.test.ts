import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { newTraceId } from "./helpers/bus";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Core } from "@openomni/agent";
import { z } from "zod";
import { sessionFilePath } from "../src/composition/cluster-runtime";
import { planeOf } from "./helpers/ledger";
import { residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";

import { messageStart, messageEnd, sseResponse } from "./helpers/anthropic-sse";

const suite = residentSuite();

function textResponse(text: string): Response {
  const frames = [
    messageStart("provider-message", "fixture", 12000),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    ...messageEnd("end_turn", 10),
  ];
  return sseResponse(frames);
}

test("real app SSE compaction commits reversible evidence through the session executor", async () => {
  // Given: real provider wire, real SDK, real app and file-backed SQLite.
  let requests = 0;
  let summaries = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/v1/messages");
      expect(request.headers.get("x-api-key")).toBe("fixture-key");
      const body = z
        .object({ stream: z.literal(true), max_tokens: z.number().optional() })
        .parse(JSON.parse(await request.text()));
      requests += 1;
      const summary = body.max_tokens === 5000;
      if (summary) summaries += 1;
      return textResponse(summary ? "checkpoint" : "retained evidence ".repeat(160));
    },
  });
  suite.defer(() => provider.stop(true));
  const providerPort = provider.port;
  const config = suite.config("openomni-937-sse-", {
    wsToken: "fixture-token",
    model: {
      provider: "anthropic",
      id: "fixture",
      apiKey: "fixture-key",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    },
  });
  const model: Core.ResolvedModel = {
    id: "fixture",
    name: "fixture",
    providerID: "anthropic",
    api: { npm: "@ai-sdk/anthropic", url: config.model.baseUrl },
    limit: { context: 10000 },
  };
  const app = await suite.boot({ config, llm: { resolveModel: () => Effect.succeed(model) } });
  const plane = await planeOf(app.runtime);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "fixture-token"]);
  expect(socket.protocol).toBe("auth");
  // When: enough completed turns cross the actual compaction threshold.
  for (let index = 0; index < 4; index += 1) {
    const received = nextResidentTurn(plane, 5000);
    socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: `input-${index}` }));
    expect((await received).text).toBe("retained evidence ".repeat(160).trimEnd());
  }
  // Then: the real durable action has content-addressed original evidence.
  const rows = plane.listSessions().filter((row) => row.id !== "gateway-ingress");
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) throw new Error("missing session");
  const actions = sessionTree(row.id, plane.sessionStore(row.id).actions);
  const compacted = actions.filter((action) => action.kind === "compaction" && "revert" in action);
  expect(compacted.length).toBeGreaterThan(0);
  for (const action of compacted) {
    expect(action.effect.value).toHaveProperty("result.discarded.sha256");
    expect(action.effect.value).toHaveProperty("result.firstKeptEntryId");
    expect(action.effect.value).toHaveProperty("result.revert.removedEntries");
  }
  expect(summaries).toBeGreaterThan(0);
  const sessionsDir = config.sessionsDir;
  if (sessionsDir === undefined) throw new Error("suite config is missing sessionsDir");
  const db = new Database(sessionFilePath(sessionsDir, row.id), { readonly: true });
  try {
    const persisted = db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM action WHERE kind = 'compaction'",
      )
      .get();
    expect(persisted?.count).toBe(actions.filter((action) => action.kind === "compaction").length);
    console.log(
      "937 real SSE compaction",
      JSON.stringify({
        requests,
        summaries,
        sessionId: row.id,
        compactionIds: compacted.map((action) => action.id),
        persisted,
      }),
    );
  } finally {
    db.close();
  }
  await suite.cleanup();
  expect(existsSync(dirname(sessionsDir))).toBe(false);
  expect(socket.readyState).toBe(WebSocket.CLOSED);
  for (const port of [providerPort, app.port]) {
    const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    await probe.stop(true);
  }
});
