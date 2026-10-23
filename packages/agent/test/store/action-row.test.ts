import { expect, test } from "bun:test";
import type { LedgerAction } from "@oni/protocol";
import { storedActionRow } from "../../src/core/store/action-row";
import { ActionSqlRow } from "../../src/core/store/storage/sqlite-l0-rows";
import { materializeRow, openLedgerDatabase, observedL0Adapters, residentRow } from "./helpers/ledger";

const action: LedgerAction.Append = {
  id: "tool-1", sessionId: "session", parentId: null, kind: "tool",
  intent: { encodingVersion: 1, value: { text: "a|b", nested: [1, null] } },
  effect: { encodingVersion: 1, value: { result: "done" } },
  irreversible: true, ts: 10,
};

test("append persists every serialized payload column and reads the same action", () => {
  using db = openLedgerDatabase();
  const { adapter } = observedL0Adapters(db);
  materializeRow(adapter.sessions, residentRow("session"));
  const receipt = adapter.actions.append(action, 1);
  const stored = ActionSqlRow.parse(db.query("SELECT * FROM action WHERE id = ?").get(action.id));
  expect(stored).toEqual({
    id: "tool-1", session_id: "session", parent_id: null, kind: "tool",
    intent: '{"text":"a|b","nested":[1,null]}', effect: '{"result":"done"}',
    revert: null, irreversible: 1, encoding_version: 1, ts: 10, ordinal: 2,
  });
  expect(storedActionRow(action, 2)).toEqual(stored);
  expect(receipt).toEqual({ action: { ...action, ordinal: 2 }, revision: 2 });
  expect(adapter.actions.range("session", 1, 1)).toEqual([{ ...action, ordinal: 2 }]);
});

test("revertible actions preserve their stored revert bytes", () => {
  using db = openLedgerDatabase();
  const { adapter } = observedL0Adapters(db);
  materializeRow(adapter.sessions, residentRow("session"));
  const { irreversible: _irreversible, ...base } = action;
  const reversible = { ...base, revert: { encodingVersion: 1 as const, value: { undo: "a|b" } } };
  const receipt = adapter.actions.append(reversible, 1);
  expect(db.query("SELECT revert, irreversible FROM action WHERE id = ?").get(action.id))
    .toEqual({ revert: '{"undo":"a|b"}', irreversible: 0 });
  expect(adapter.actions.actionById(action.id)).toEqual(receipt?.action);
});

for (const ts of [10.5, 9_007_199_254_740_992]) {
  test(`epoch instant ${ts} round-trips through append and range`, () => {
    using db = openLedgerDatabase();
    const { adapter } = observedL0Adapters(db);
    materializeRow(adapter.sessions, residentRow("session"));
    const receipt = adapter.actions.append({ ...action, ts }, 1);
    expect(receipt?.action.ts).toBe(ts);
    expect(adapter.actions.range("session", 1, 1)[0]?.ts).toBe(ts);
  });
}

test("append assigns the next session revision even after an ordinal gap", () => {
  using db = openLedgerDatabase();
  const { adapter } = observedL0Adapters(db);
  materializeRow(adapter.sessions, residentRow("session"));
  db.run("UPDATE session SET revision = 8 WHERE id = 'session'");
  const receipt = adapter.actions.append(action, 8);
  expect(receipt?.revision).toBe(9);
  expect(adapter.actions.actionById(action.id)?.ordinal).toBe(9);
});
