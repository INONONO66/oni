import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LedgerAction, type SessionGeneration, SessionTurn } from "@openomni/protocol";
import { createSessionKernel } from "../../../src/core/store/fence";
import { openCatalogStore } from "../../../src/core/store/catalog";
import { actionPayloadBytes } from "../../../src/core/store/action-hash";
import { SchemaRefused } from "../../../src/core/store/errors";
import { openSessionStore, SESSION_FILE_SCHEMA } from "../../../src/core/store/session-file";
import { runLedgerSync } from "../helpers/effect";
import { materializeSession } from "../helpers/session";
import { testNow, withDiskStores } from "../helpers/storage";
import { expectBusyBeforeSchema, policyFixture } from "./store-fixtures";

function tableCensus(path: string): Array<{ name: string }> {
  const raw = new Database(path, { readonly: true });
  try {
    return raw
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
  } finally {
    raw.close();
  }
}

function turnIntentAction(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string;
  readonly generation: SessionGeneration.Snapshot;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: {
      encodingVersion: 1,
      value: SessionTurn.HistoricalIntent.parse({
        phase: "intent",
        resultId: `${input.id}:result`,
        deliveryIds: [],
        toolsGeneration: input.generation.generation,
        toolsHash: input.generation.toolsHash,
        systemHash: input.generation.systemHash,
        policyGeneration: input.generation.policyGeneration,
        resumeCount: 0,
        boundaryActionId: null,
      }),
    },
    effect: { encodingVersion: 1, value: SessionTurn.Pending.parse({ phase: "pending" }) },
    irreversible: true,
    ts: 3,
  };
}

test("openSessionStore bootstraps a fresh session file: exactly the five session tables, WAL", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-store-"));
  const path = join(directory, "s1.sqlite");
  const store = openSessionStore(path, { now: testNow });
  try {
    expect(tableCensus(path)).toEqual([
      { name: "action" },
      { name: "armed_alarms" },
      { name: "decision_fact" },
      { name: "session" },
      { name: "tool_outputs" },
    ]);
    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    } finally {
      raw.close();
    }
  } finally {
    store.close();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

// W5.2 review F9: busy_timeout is connection-local (it never touches the db
// file), so a non-SQLite payload makes the first file-touching statement throw
// NOTADB — observing busy_timeout=5000 after that throw proves the pragma ran
// strictly before any schema statement.
test("F9: session-file bootstrap applies busy_timeout before any schema statement", () => {
  expectBusyBeforeSchema(SESSION_FILE_SCHEMA);
});

test("openSessionStore rejects a corrupt payload instead of returning a handle", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-store-"));
  const path = join(directory, "notadb.sqlite");
  writeFileSync(path, "this file is deliberately not a sqlite database");
  try {
    expect(() => openSessionStore(path, { now: testNow })).toThrow(
      expect.objectContaining({ code: "SQLITE_NOTADB", errno: 26 }),
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("createSessionKernel serves session facts from the session file and policy rows from the catalog", () => {
  withDiskStores("session-store", ({ session, catalog, kernel }) => {
    const created = materializeSession(kernel, "s1");
    expect(created).toMatchObject({ id: "s1", state: "idle" });

    const adopted = runLedgerSync(
      kernel.adoptFence({ sessionId: "s1", owner: "owner", fence: created.fence + 1 }),
    );
    expect(adopted).toEqual({ ok: true, fence: 1 });

    const generation = kernel.latestGenerationFor("s1");
    const committed = runLedgerSync(
      kernel.commit({
        sessionId: "s1",
        owner: "owner",
        fence: adopted.fence,
        now: 3,
        expectedRevision: kernel.row("s1").revision,
        actions: [
          turnIntentAction({ id: "turn-1", sessionId: "s1", parentId: "s1:configure", generation }),
        ],
        state: "running",
      }),
    );
    expect(committed.ok).toBe(true);

    expect(kernel.verifyChain("s1")).toMatchObject({ kind: "intact", length: 2 });
    expect(kernel.getSnapshot("s1")).toMatchObject({
      id: "s1",
      state: "running",
      openTurnId: "turn-1",
    });
    expect(kernel.historyPage("s1").actions.map((action) => action.kind)).toEqual([
      "session.configure",
      "turn",
    ]);
    expect(kernel.latestFoldCheckpoint("s1")).toEqual({
      revision: kernel.row("s1").revision,
      checkpoint: undefined,
    });

    // Decision facts live inside the same per-session file.
    const outcome = session.decisionFacts.record({
      key: "k1",
      type: "test",
      data: { value: 1 },
      timeCreated: 4,
    });
    expect(outcome.kind).toBe("recorded");
    expect(session.decisionFacts.head("k1")?.rowHash).toBe(outcome.fact.rowHash);

    // Policy rows come from the catalog, not the session file.
    expect(
      catalog.policies.append(policyFixture),
    ).toBe(true);
    expect(kernel.policyRows()).toHaveLength(1);
    expect(kernel.currentPolicyGeneration()).toBe(1);

    // The input-queue-table plane is gone (W5.2 #1197): pending work is a pure
    // projection over undelivered prompt actions, and a fresh file has none.
    expect(kernel.pendingMessages("s1")).toEqual([]);
  });
});

// ─── #1347 row payload cap at the append boundary ───

/** A note-kind prompt row whose serialized payload lands exactly on `bytes` (intent + effect JSON). */
function promptRowOfBytes(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string;
  readonly bytes: number;
}): LedgerAction.Append {
  const intent = { deliveryId: input.id, delivery: "followUp" as const };
  const effect = (content: string) => ({ deliveryKind: "prompt" as const, content });
  const fixed = actionPayloadBytes({
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "prompt",
    intent: { encodingVersion: 1, value: intent },
    effect: { encodingVersion: 1, value: effect("") },
    irreversible: true,
    ts: 3,
  });
  const row: LedgerAction.Append = {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "prompt",
    intent: { encodingVersion: 1, value: intent },
    effect: { encodingVersion: 1, value: effect("x".repeat(input.bytes - fixed)) },
    irreversible: true,
    ts: 3,
  };
  expect(actionPayloadBytes(row)).toBe(input.bytes);
  return row;
}

function chainHead(path: string): { count: number; head: string | null } {
  const raw = new Database(path, { readonly: true });
  try {
    const count = raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM action").get()?.n ?? 0;
    const head =
      raw
        .query<{ action_hash: string }, []>(
          "SELECT action_hash FROM action ORDER BY ordinal DESC LIMIT 1",
        )
        .get()?.action_hash ?? null;
    return { count, head };
  } finally {
    raw.close();
  }
}

test("#1347 row cap: exactly the cap commits, one byte over refuses `row_bytes` and nothing advances", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-store-"));
  const path = join(directory, "s2.sqlite");
  const session = openSessionStore(path, { now: testNow });
  const catalog = openCatalogStore(join(directory, "catalog.sqlite"), { now: testNow });
  try {
    const kernel = createSessionKernel(session, catalog);
    const created = runLedgerSync(
      kernel.materialize({
        id: "s2",
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: 0,
        actionId: "s2:configure",
        at: 1,
      }),
    );
    const adopted = runLedgerSync(
      kernel.adoptFence({ sessionId: "s2", owner: "owner", fence: created.row.fence + 1 }),
    );
    const commit = (actions: LedgerAction.Append[]) =>
      kernel.commit({
        sessionId: "s2",
        owner: "owner",
        fence: adopted.fence,
        now: 3,
        expectedRevision: kernel.row("s2").revision,
        actions,
        state: "idle",
      });

    // The boundary itself, pinned as the issue's literal 1 MiB and not the constant: a payload of exactly 1_048_576 bytes lands.
    const atCap = promptRowOfBytes({ id: "s2:at-cap", sessionId: "s2", parentId: "s2:configure", bytes: 1_048_576 });
    expect(runLedgerSync(commit([atCap])).ok).toBe(true);
    const settled = chainHead(path);
    expect(settled.count).toBe(2);
    const revision = kernel.row("s2").revision;

    // One byte over: typed refusal on the existing error, before any chain mutation.
    const over = promptRowOfBytes({ id: "s2:over", sessionId: "s2", parentId: "s2:at-cap", bytes: 1_048_577 });
    const refused = runLedgerSync(Effect.flip(commit([over])));
    expect(refused).toBeInstanceOf(SchemaRefused);
    expect(refused).toMatchObject({ sessionId: "s2", actionId: "s2:over", kind: "prompt", reason: "row_bytes" });
    expect(chainHead(path)).toEqual(settled);
    expect(kernel.row("s2").revision).toBe(revision);

    // Rollback of a batch: a conforming row ahead of the oversized one is rolled back with it.
    const small = promptRowOfBytes({ id: "s2:small", sessionId: "s2", parentId: "s2:at-cap", bytes: 256 });
    const batch = runLedgerSync(Effect.flip(commit([small, { ...over, parentId: "s2:small" }])));
    expect(batch).toMatchObject({ _tag: "SchemaRefused", actionId: "s2:over", reason: "row_bytes" });
    expect(chainHead(path)).toEqual(settled);
    expect(kernel.row("s2").revision).toBe(revision);
    expect(kernel.verifyChain("s2")).toMatchObject({ kind: "intact", length: 2 });

    // The injected cap, not a literal: a store opened with a smaller cap refuses the same 256-byte row.
    session.close();
    const tight = openSessionStore(path, { now: testNow, rowByteCap: 255 });
    try {
      const tightKernel = createSessionKernel(tight, catalog);
      const tightRefusal = runLedgerSync(
        Effect.flip(
          tightKernel.commit({
            sessionId: "s2",
            owner: "owner",
            fence: adopted.fence,
            now: 3,
            expectedRevision: tightKernel.row("s2").revision,
            actions: [small],
            state: "idle",
          }),
        ),
      );
      expect(tightRefusal).toMatchObject({ _tag: "SchemaRefused", actionId: "s2:small", reason: "row_bytes" });
      expect(chainHead(path)).toEqual(settled);
    } finally {
      tight.close();
    }
  } finally {
    catalog.close();
    rmSync(directory, { recursive: true });
  }
});

test("#1347 row cap covers schema-exempt checkpoint rows and the materialize genesis row", () => {
  withDiskStores("session-store", ({ session, kernel, path }) => {
    // An oversized genesis row never creates the session: no row, no chain.
    const genesis = runLedgerSync(
      Effect.flip(
        kernel.materialize({
          id: "s3",
          parentId: null,
          role: "resident",
          tools: [],
          system: { preset: "", blocks: [{ id: "big", source: "fixture", content: "y".repeat(600) }] },
          policyGeneration: 0,
          actionId: "s3:configure",
          at: 1,
        }),
      ),
    );
    expect(genesis).toMatchObject({ _tag: "SchemaRefused", actionId: "s3:configure", reason: "row_bytes" });
    expect(session.sessions.get("s3")).toBeUndefined();
    expect(chainHead(path)).toEqual({ count: 0, head: null });

    const created = materializeSession(kernel, "s3");
    const adopted = runLedgerSync(
      kernel.adoptFence({ sessionId: "s3", owner: "owner", fence: created.fence + 1 }),
    );
    const settled = chainHead(path);
    const checkpoint: LedgerAction.Append = {
      id: "s3:checkpoint",
      parentId: "s3:configure",
      sessionId: "s3",
      kind: "fold.checkpoint",
      intent: { encodingVersion: 1, value: { note: "z".repeat(600) } },
      effect: { encodingVersion: 1, value: {} },
      irreversible: true,
      ts: 3,
    };
    const refused = runLedgerSync(
      Effect.flip(
        kernel.commit({
          sessionId: "s3",
          owner: "owner",
          fence: adopted.fence,
          now: 3,
          expectedRevision: kernel.row("s3").revision,
          actions: [checkpoint],
          state: "idle",
        }),
      ),
    );
    expect(refused).toMatchObject({ _tag: "SchemaRefused", kind: "fold.checkpoint", reason: "row_bytes" });
    expect(chainHead(path)).toEqual(settled);
  }, { sessionFile: "s3.sqlite", session: { rowByteCap: 512 } });
});
