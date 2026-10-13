import { sessionTree } from "./helpers/session-tree";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { LedgerAction } from "@openomni/protocol";
import { computeActionHash, GENESIS_PREV_HASH } from "../../src/core/store/session-file";
import { ActionSqlRow } from "../../src/core/store/storage/sqlite-l0-rows";
import {
  materializeRow,
  openLedgerDatabase,
  observedL0Adapters,
  residentRow,
  type L0Adapters,
} from "./helpers/ledger";

function append(id: string, sessionId = "chain"): LedgerAction.Append {
  return {
    id,
    sessionId,
    parentId: null,
    kind: "tool",
    intent: { encodingVersion: 1, value: { text: "a|b", nested: [1, null] } },
    effect: { encodingVersion: 1, value: { result: id } },
    irreversible: true,
    ts: 10,
  };
}

// The genesis configure row is ordinal 1; `a1`..`a3` follow at ordinals 2..4.
function fresh(db: Database): L0Adapters {
  const { adapter } = observedL0Adapters(db);
  expect(materializeRow(adapter.sessions, residentRow("chain"))).toBe(true);
  for (let index = 1; index <= 3; index += 1) {
    expect(adapter.actions.append(append(`a${index}`), index)?.revision).toBe(index + 1);
  }
  return adapter;
}

function stored(db: Database, ordinal: number, sessionId = "chain") {
  return ActionSqlRow.parse(
    db.query("SELECT * FROM action WHERE session_id = ? AND ordinal = ?").get(sessionId, ordinal),
  );
}

function broken(adapter: L0Adapters, ordinal: number) {
  const verdict = LedgerAction.ChainVerdict.parse(adapter.actions.verifyChain("chain"));
  expect(verdict.kind).toBe("broken");
  if (verdict.kind !== "broken") throw new Error("expected broken chain");
  expect(verdict.ordinal).toBe(ordinal);
  expect(verdict.expected).not.toBe(verdict.actual);
  return verdict;
}

test("empty action chain has no head", () => {
  using db = openLedgerDatabase();
  const { adapter } = observedL0Adapters(db);
  expect(adapter.actions.verifyChain("empty")).toEqual({
    kind: "intact",
    head: null,
    length: 0,
  });
});

test("the genesis row and three committed actions bind every stored field and expose their hashes", () => {
  using db = openLedgerDatabase();
  const adapter = fresh(db);
  const first = stored(db, 1);
  const head = stored(db, 4);
  const framed = JSON.stringify([
    GENESIS_PREV_HASH,
    first.id,
    first.parent_id,
    first.session_id,
    first.kind,
    first.intent,
    first.effect,
    first.revert,
    first.irreversible,
    first.encoding_version,
    first.ts,
    first.ordinal,
  ]);
  expect(first.action_hash).toBe(createHash("sha256").update(framed).digest("hex"));
  expect(first.prev_hash).toBe(GENESIS_PREV_HASH);
  expect(adapter.actions.verifyChain("chain")).toEqual({
    kind: "intact",
    length: 4,
    head: computeActionHash(head),
  });
  expect(sessionTree("chain", adapter.actions)[3]).toMatchObject({
    prevHash: head.prev_hash,
    actionHash: head.action_hash,
  });
  expect(adapter.actions.range("chain", 3, 1)[0]).toMatchObject({
    prevHash: head.prev_hash,
    actionHash: head.action_hash,
  });
});

test("effect tampering breaks at ordinal two", () => {
  using db = openLedgerDatabase();
  const adapter = fresh(db);
  db.run("UPDATE action SET effect = ? WHERE ordinal = 2", ['{ "tampered": true }']);
  const verdict = broken(adapter, 2);
  expect(verdict.expected).toBe(computeActionHash(stored(db, 2)));
  expect(verdict.actual).toBe(stored(db, 2).action_hash);
});

test("swapping ordinals two and three breaks the chain", () => {
  using db = openLedgerDatabase();
  const adapter = fresh(db);
  db.run("UPDATE action SET ordinal = 99 WHERE ordinal = 2");
  db.run("UPDATE action SET ordinal = 2 WHERE ordinal = 3");
  db.run("UPDATE action SET ordinal = 3 WHERE ordinal = 99");
  broken(adapter, 2);
});

test("rewriting a row hash cannot conceal a broken link to its successor", () => {
  using db = openLedgerDatabase();
  const adapter = fresh(db);
  db.run("UPDATE action SET effect = '{}' WHERE ordinal = 2");
  db.run("UPDATE action SET action_hash = ? WHERE ordinal = 2", [computeActionHash(stored(db, 2))]);
  expect(broken(adapter, 3)).toEqual({
    kind: "broken",
    ordinal: 3,
    expected: stored(db, 2).action_hash,
    actual: stored(db, 3).prev_hash,
  });
});

for (const column of ["prev_hash", "action_hash"] as const) {
  test(`the fresh schema refuses a null ${column} outright`, () => {
    using db = openLedgerDatabase();
    fresh(db);
    expect(() => db.run(`UPDATE action SET ${column} = NULL WHERE ordinal = 2`)).toThrow(
      "NOT NULL constraint failed",
    );
  });

  test(`blob-typed ${column} fails verification without throwing`, () => {
    using db = openLedgerDatabase();
    const adapter = fresh(db);
    db.run(`UPDATE action SET ${column} = X'303132' WHERE ordinal = 2`);
    expect(broken(adapter, 2).actual).toBe("blob:303132");
    expect(db.query(`SELECT typeof(${column}) AS t FROM action WHERE ordinal = 2`).get()).toEqual({
      t: "blob",
    });
  });
}

for (const ts of [10.5, 9_007_199_254_740_992]) {
  test(`epoch instant ${ts} round-trips through append, tree and verification`, () => {
    using db = openLedgerDatabase();
    const adapter = fresh(db);
    const receipt = adapter.actions.append({ ...append("t"), ts }, 4);
    expect(receipt?.action.ts).toBe(ts);
    expect(sessionTree("chain", adapter.actions).at(-1)?.ts).toBe(ts);
    expect(adapter.actions.verifyChain("chain")).toEqual({
      kind: "intact",
      length: 5,
      head: computeActionHash(stored(db, 5)),
    });
  });
}

test("append uses the actual head hash rather than revision minus one", () => {
  using db = openLedgerDatabase();
  const adapter = fresh(db);
  const head = stored(db, 4).action_hash;
  db.run("UPDATE session SET revision = 8 WHERE id = 'chain'");
  const receipt = adapter.actions.append(append("after-gap"), 8);
  expect(receipt?.action.prevHash).toBe(head);
  expect(stored(db, 9).prev_hash).toBe(head);
});

test("revertible rows hash the stored revert bytes", () => {
  using db = openLedgerDatabase();
  const adapter = fresh(db);
  const action = append("revert");
  const receipt = adapter.actions.append(
    {
      id: action.id,
      sessionId: action.sessionId,
      parentId: "a3",
      kind: action.kind,
      intent: action.intent,
      effect: action.effect,
      ts: action.ts,
      revert: { encodingVersion: 1, value: { undo: "a3" } },
    },
    4,
  );
  expect(receipt?.action.actionHash).toBe(computeActionHash(stored(db, 5)));
  expect(adapter.actions.verifyChain("chain").kind).toBe("intact");
});
