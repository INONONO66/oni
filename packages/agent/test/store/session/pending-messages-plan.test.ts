import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PENDING_MESSAGES_SQL } from "../../../src/core/store/session-file/reads";
import { SESSION_FILE_SCHEMA } from "../../../src/core/store/session-file";

const OLD_SQL = `
  SELECT a.id FROM action a WHERE a.session_id = ? AND a.kind IN ('prompt', 'signal', 'action')
    AND json_extract(a.effect, '$.deliveryKind') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM action d WHERE d.session_id = a.session_id
      AND d.kind IN ('prompt', 'signal', 'action')
      AND json_extract(d.intent, '$.deliveryId') = a.id)
    AND NOT EXISTS (SELECT 1 FROM action t, json_each(t.intent, '$.consumedStale') stale
      WHERE t.session_id = a.session_id AND t.kind = 'turn' AND json_valid(t.intent)
      AND stale.value = a.id)
  ORDER BY a.ordinal`;

function ledger(turns: number): { readonly db: Database; readonly close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "a1-pending-plan-"));
  const db = new Database(join(directory, "session.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  for (const statement of SESSION_FILE_SCHEMA) db.exec(statement);
  db.query("INSERT INTO session (id) VALUES ('s')").run();
  const insert = db.query(`
    INSERT INTO action
      (id, parent_id, session_id, kind, intent, effect, revert, irreversible,
       encoding_version, ts, ordinal, prev_hash, action_hash)
    VALUES (?, NULL, 's', ?, ?, ?, NULL, 1, 1, 1, ?, 'previous', ?)
  `);
  db.transaction(() => {
    let ordinal = 0;
    const add = (id: string, kind: string, intent: object, effect: object) => {
      ordinal += 1;
      insert.run(id, kind, JSON.stringify(intent), JSON.stringify(effect), ordinal, `hash-${ordinal}`);
    };
    for (let i = 0; i < turns; i += 1) {
      add(`input-${i}`, "prompt", {}, { deliveryKind: "prompt", content: `message-${i}` });
      add(`turn-${i}`, "turn", { consumedStale: i % 20 === 0 ? [`input-${i}`] : [] }, {});
      if (i % 3 !== 0 && i < turns - 2)
        add(`delivery-${i}`, "prompt", { deliveryId: `input-${i}` }, {});
      // A NULL delivery id must not poison either anti-join.
      if (i === 0) add("null-delivery", "prompt", { deliveryId: null }, {});
    }
  }).immediate();
  return {
    db,
    close: () => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test.each([1000, 5000])("pending messages preserve ids and use a non-correlated plan at %i turns", (turns) => {
  const { db, close } = ledger(turns);
  try {
    const old = db.query<{ id: string }, [string]>(OLD_SQL);
    const current = db.query<{ id: string }, [string, string, string]>(PENDING_MESSAGES_SQL);
    const beforeStart = Bun.nanoseconds();
    const before = old.all("s").map(({ id }) => id);
    const beforeMs = (Bun.nanoseconds() - beforeStart) / 1e6;
    const afterStart = Bun.nanoseconds();
    const after = current.all("s", "s", "s").map(({ id }) => id);
    const afterMs = (Bun.nanoseconds() - afterStart) / 1e6;
    const plan = db.query<{ detail: string }, [string, string, string]>(
      `EXPLAIN QUERY PLAN ${PENDING_MESSAGES_SQL}`,
    ).all("s", "s", "s").map(({ detail }) => detail).join("\n");
    console.log(`pendingMessages ${turns} turns: old=${beforeMs.toFixed(1)}ms new=${afterMs.toFixed(1)}ms ids equal (same:${before.join() === after.join()})`);
    expect(after).toEqual(before);
    expect(after).toContain(`input-${turns - 1}`);
    expect(plan).toContain("LIST SUBQUERY");
    expect(plan).not.toMatch(/CORRELATED|SCAN d|SCAN t/);
  } finally {
    close();
  }
}, 60_000);
