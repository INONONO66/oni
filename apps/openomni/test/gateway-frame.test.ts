/**
 * #1253 — gateway frames after the four-RPC switch: `session_bound` keeps its
 * fields, and the page's `usage` is byte-equal to the `llm` attempt fold DTO
 * (`Inspect.attemptUsage` over the same committed chain window). Everything
 * here is a synchronous read over a real kernel — event-driven data, no waits.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type Core, Inspect } from "@openomni/agent";
import { createSessionKernel } from "../../../packages/agent/src/core/store/fence";
import { openCatalogStore } from "../../../packages/agent/src/core/store/catalog";
import { openSessionStore } from "../../../packages/agent/src/core/store/session-file";
import { SessionRead } from "@openomni/protocol";
import { readSessionCursor } from "../src/gateway";
import { clusterTempDir } from "../../../packages/agent/test/helpers/cluster-runtime";
import { runEffect } from "./helpers/effect";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-gateway-frame-");
const sessionId = "frame-session";
const file = `${sessionsDir}/${sessionId}.sqlite`;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Materialize one session and commit an `llm` attempt intent/result pair. */
async function seedKernel(): Promise<Core.SessionHandleStore.SessionKernel> {
  const catalog = openCatalogStore(catalogFile, { now: () => 1 });
  const store = openSessionStore(file, { now: () => 1 });
  const kernel = createSessionKernel(store, catalog);
  await runEffect(
    kernel.materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 1,
      actionId: `${sessionId}:materialize`,
      at: 1,
    }),
  );
  catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
  const fence = catalog.rotateFence(sessionId);
  await runEffect(kernel.adoptFence({ sessionId, owner: "framer", fence }));
  const row = kernel.row(sessionId);
  const parentId = kernel.latestAction(sessionId)?.id ?? null;
  await runEffect(
    kernel.commit({
      sessionId,
      owner: "framer",
      fence,
      now: 5,
      expectedRevision: row.revision,
      actions: [
        {
          id: "llm-attempt-1",
          parentId,
          sessionId,
          kind: "llm",
          intent: { encodingVersion: 1, value: { phase: "intent", attempt: 1 } },
          effect: { encodingVersion: 1, value: { phase: "intent" } },
          ts: 5,
          irreversible: true,
        },
        {
          id: "llm-attempt-1-result",
          parentId: "llm-attempt-1",
          sessionId,
          kind: "llm",
          intent: { encodingVersion: 1, value: { phase: "result" } },
          effect: {
            encodingVersion: 1,
            value: {
              phase: "result",
              usageProvenance: "reported",
              evidence: { usage: { inputTokens: 3, outputTokens: 2 } },
            },
          },
          ts: 6,
          irreversible: true,
        },
      ],
      state: row.state,
    }),
  );
  return kernel;
}

test("attemptUsage in the read frame is byte-equal to the llm attempt fold DTO", async () => {
  const kernel = await seedKernel();
  const frame = readSessionCursor(kernel, { type: "session_read", sessionId, limit: 256 });
  expect(frame.type).toBe("session_snapshot");
  if (frame.type === "session_gap") throw new Error("seeded session returned a gap");
  const foldDto = Inspect.attemptUsage(
    kernel.historyPage(sessionId, { afterRevision: 0, limit: 256 }).actions,
  );
  expect(foldDto).toEqual([
    { attemptId: "llm-attempt-1", provenance: "reported", inputTokens: 3, outputTokens: 2 },
  ]);
  expect(JSON.stringify(frame.usage)).toBe(JSON.stringify(foldDto));
  // The frame itself round-trips the frozen page schema.
  expect(SessionRead.Page.parse(frame)).toEqual(frame);
});

test("session_bound keeps its fields and legacy pages round-trip byte-identical", () => {
  expect(Object.keys(SessionRead.Bound.shape)).toEqual(["type", "result"]);
  expect(Object.keys(SessionRead.Receipt.shape)).toEqual(["type", "status"]);
  // Wire compatibility as BEHAVIOR, not a schema-key mirror (#1257): a
  // pre-#1257 page — no `ancestry`, no `children` — parses and round-trips
  // byte-identical, so the optional fork projections cost old frames nothing.
  const legacy = {
    type: "session_snapshot",
    sessionId,
    state: "idle",
    phase: "completed",
    phaseSince: 5,
    epoch: 1,
    afterRevision: 0,
    headRevision: 2,
    nextRevision: null,
    actions: [{ revision: 1, actionId: "llm-attempt-1", kind: "llm", at: 5 }],
    usage: [],
    toolWallMs: 0,
  };
  const legacyJson = JSON.stringify(legacy);
  expect(JSON.stringify(SessionRead.Page.parse(JSON.parse(legacyJson)))).toBe(legacyJson);
  // The optional fork projections parse when present on the same frame.
  const pin = { session: sessionId, anchor: "hash-1", parentSeq: 2, parentHead: "head-2", copied: 3 };
  const forked = SessionRead.Page.parse({
    ...legacy,
    ancestry: { parentId: sessionId, forkedFrom: pin, aside: "forked aside" },
    children: [{ sessionId: "child-1", anchor: "hash-1" }],
  });
  expect(forked.ancestry).toEqual({ parentId: sessionId, forkedFrom: pin, aside: "forked aside" });
  expect(forked.children).toEqual([{ sessionId: "child-1", anchor: "hash-1" }]);
  const bound = SessionRead.Bound.parse({
    type: "session_bound",
    result: {
      status: "executed",
      handle: { messageId: "m-1", target: sessionId },
      delivery: { kind: "session" },
    },
  });
  expect(bound.result.status).toBe("executed");
});
