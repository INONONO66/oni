import { generationSnapshot, configureAction } from "../../../src/core/store/configure";
import { Effect, Result } from "effect";
import { expect, test } from "bun:test";
import type { LedgerAction, LedgerSession } from "@openomni/protocol";
import { createDecisionFactPort } from "../../../src/core/store/decision";

import { runLedgerSync } from "../helpers/effect";
import {
  materializeRow,
  openLedgerDatabase,
  observedL0Adapters,
  residentRow,
} from "../helpers/ledger";
import { useSqliteStores } from "../helpers/storage";

const stores = useSqliteStores("storage-boundaries");

function run<T, E>(effect: Effect.Effect<T, E>): T {
  return Result.getOrThrowWith(runLedgerSync(Effect.result(effect)), (error) => error);
}

test("decision fact port shares rollback and subsequent commit boundaries", () => {
  const port = createDecisionFactPort(stores.session);
  const facts = port.port();
  if (facts === undefined) throw new Error("decision facts missing");
  const input = { key: "route:boundary", type: "route.decided", data: {}, timeCreated: 1 };
  const failure = new Error("rollback fact");
  expect(() =>
    port.transaction(() => {
      facts.record(input);
      throw failure;
    }),
  ).toThrow(failure);
  expect(facts.head(input.key)).toBeUndefined();
  const outcome = port.transaction(() => facts.record(input));
  expect(outcome.kind).toBe("recorded");
  expect(facts.head(input.key)).toEqual(outcome.fact);
});

test("fence adoption reports a refused SQL compare-and-set without advancing its fence", () => {
  using db = openLedgerDatabase();
  const { adapter } = observedL0Adapters(db);
  materializeRow(adapter.sessions, residentRow("fenced"));
  db.run(
    "CREATE TRIGGER refuse_fence BEFORE UPDATE OF lease_fence ON session BEGIN SELECT RAISE(IGNORE); END",
  );
  expect(() =>
    run(adapter.sessions.adoptFence({ sessionId: "fenced", owner: "child", fence: 1 })),
  ).toThrow(expect.objectContaining({ _tag: "FenceRefused", reason: "stale", fence: 0 }));
  expect(adapter.sessions.get("fenced")?.fenceOwner).toBeNull();
});

test("materialization refuses a mismatched initial action before creating any row", () => {
  using db = openLedgerDatabase();
  const { adapter } = observedL0Adapters(db);
  const snapshot = generationSnapshot({
    generation: 1,
    revertTo: 0,
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 0,
  });
  const row: LedgerSession.Row = {
    id: "source",
    parentId: null,
    role: "resident",
    fenceOwner: null,
    fence: 0,
    revision: 0,
    state: "idle",
    toolsGeneration: 1,
    systemHash: snapshot.systemHash,
    policyGeneration: 0,
  };
  const existing = run(
    adapter.sessions.materialize({
      row,
      initialAction: configureAction({
        id: "source:configure",
        sessionId: "source",
        parentId: null,
        operation: "create",
        snapshot,
        at: 1,
      }),
    }),
  );
  expect(existing.created).toBe(true);
  const initial = configureAction({
    id: "configuration",
    sessionId: "source",
    parentId: null,
    operation: "create",
    at: 1,
    snapshot,
  });
  expect(() =>
    run(adapter.sessions.materialize({ row: { ...row, id: "new" }, initialAction: initial })),
  ).toThrow(expect.objectContaining({ _tag: "MaterializeRefused" }));
  expect(adapter.sessions.list().map((session) => session.id)).toEqual(["source"]);
});

test("session commit savepoints roll back every refused write unit", () => {
  using db = openLedgerDatabase();
  const { adapter } = observedL0Adapters(db);
  materializeRow(adapter.sessions, residentRow("savepoint"));
  run(adapter.sessions.adoptFence({ sessionId: "savepoint", owner: "owner", fence: 1 }));
  db.run(
    "CREATE TRIGGER refuse_revision BEFORE UPDATE OF revision ON session BEGIN SELECT RAISE(IGNORE); END",
  );
  const action: LedgerAction.Append = {
    id: "refused-action",
    parentId: null,
    sessionId: "savepoint",
    kind: "tool",
    intent: { encodingVersion: 1, value: {} },
    effect: { encodingVersion: 1, value: {} },
    irreversible: true,
    ts: 2,
  };
  const request: LedgerSession.Commit = {
    sessionId: "savepoint",
    owner: "owner",
    fence: 1,
    now: 2,
    expectedRevision: 1,
    actions: [action],
    state: "idle",
  };
  expect(() => run(adapter.sessions.commit(request))).toThrow(
    expect.objectContaining({ _tag: "CommitRefused", reason: "revision" }),
  );
  expect(db.query("SELECT 1 FROM action WHERE id = 'refused-action'").get()).toBeNull();
  expect(adapter.sessions.get("savepoint")?.revision).toBe(1);
  db.run("DROP TRIGGER refuse_revision");
  expect(run(adapter.sessions.commit(request)).ok).toBe(true);
  expect(adapter.sessions.get("savepoint")?.revision).toBe(2);
});
