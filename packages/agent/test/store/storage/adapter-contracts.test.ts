import { sessionTree } from "../helpers/session-tree";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { LedgerAction, type LedgerSession, PolicyRow } from "@openomni/protocol";
import { materializeRow, residentRow } from "../helpers/ledger";
import { useSqliteStores } from "../helpers/storage";

const stores = useSqliteStores("ledger-contract");
let inspection: Database;
beforeEach(() => {
  inspection = new Database(stores.sessionPath);
});
afterEach(() => {
  inspection.close();
});

const encoded = (value: string) => ({ encodingVersion: 1 as const, value: { value } });

const sessionRow = residentRow;

/** Genesis configure lands at revision 1; a second materialize reports `created: false`. */
function materialize(row: LedgerSession.Row): boolean {
  return materializeRow(stores.session.sessions, row);
}

describe("L0 adapter contracts", () => {
  test("session, action and policy planes hold their append contracts", () => {
    const session = sessionRow("session-l0");
    expect(materialize(session)).toBe(true);
    expect(materialize(session)).toBe(false);

    const root = stores.session.actions.append(
      LedgerAction.Append.parse({
        id: "action-root",
        parentId: null,
        sessionId: session.id,
        kind: "turn",
        intent: encoded("intent"),
        effect: encoded("result"),
        irreversible: true,
        ts: 100,
      }),
      1,
    );
    expect(root?.revision).toBe(2);

    expect(materialize(sessionRow("session-other"))).toBe(true);
    expect(
      stores.session.actions.append(
        LedgerAction.Append.parse({
          id: "action-foreign-parent",
          parentId: "action-root",
          sessionId: "session-other",
          kind: "tool",
          intent: encoded("foreign"),
          effect: encoded("foreign"),
          irreversible: true,
          ts: 100,
        }),
        1,
      ),
    ).toBeUndefined();
    expect(stores.session.sessions.get("session-other")?.revision).toBe(1);

    expect(
      stores.session.actions.append(
        LedgerAction.Append.parse({
          id: "action-stale",
          parentId: "action-root",
          sessionId: session.id,
          kind: "tool",
          intent: encoded("stale"),
          effect: encoded("stale"),
          irreversible: true,
          ts: 101,
        }),
        1,
      ),
    ).toBeUndefined();

    const reverted = stores.session.actions.append(
      LedgerAction.Append.parse({
        id: "action-revert",
        parentId: "action-root",
        sessionId: session.id,
        kind: "tool",
        intent: encoded("undo"),
        effect: encoded("undone"),
        revert: encoded("action-root"),
        ts: 102,
      }),
      2,
    );
    expect(reverted?.revision).toBe(3);
    expect(stores.session.sessions.get(session.id)?.revision).toBe(3);

    const policy = PolicyRow.Row.parse({
      name: "allow-tool",
      kind: "tool",
      phase: "pre",
      match: encoded("all"),
      verdict: encoded("allow"),
      priority: 10,
      generation: 1,
    });
    expect(stores.catalog.policies.append(policy)).toBe(true);
    expect(stores.catalog.policies.append(policy)).toBe(false);
    expect(stores.catalog.policies.rows()).toEqual([policy]);
    expect(stores.session.sessions.get(session.id)?.revision).toBe(3);

    const whole = sessionTree(session.id, stores.session.actions);
    expect(stores.session.actions.range(session.id, 0, 1)).toEqual(whole.slice(0, 1));
    expect(stores.session.actions.range(session.id, 1, 100)).toEqual(whole.slice(1));
    expect(stores.session.actions.range(session.id, whole.length, 1)).toEqual([]);
  });
});

describe("SQLite adapter contract guards", () => {
  test("decision-fact reads reject malformed persisted JSON", () => {
    const fact = stores.session.decisionFacts.record({
      key: "route:corrupt",
      type: "route.decided",
      data: { value: "valid" },
      timeCreated: 10,
    });
    expect(fact.kind).toBe("recorded");
    inspection.query("UPDATE decision_fact SET data = ? WHERE key = ?").run("{", fact.fact.key);

    expect(() => stores.session.decisionFacts.head(fact.fact.key)).toThrow(
      expect.objectContaining({ _tag: "SchemaRefused", reason: "json" }),
    );
  });

  test("fresh session files omit retired lifecycle tables", () => {
    const rows = inspection
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name IN ('conversation', 'lease', 'engagement', 'inbox', 'alarm', 'watch_source', '_migrations')
         ORDER BY name`,
      )
      .all();
    expect(rows).toEqual([]);
  });

  test("action revision rolls back when the append insert fails", () => {
    const row = sessionRow("session-action-rollback");
    expect(materialize(row)).toBe(true);
    inspection.exec(`
      CREATE TRIGGER refuse_action BEFORE INSERT ON action
      BEGIN SELECT RAISE(ABORT, 'refuse action'); END
    `);
    expect(() =>
      stores.session.actions.append(
        LedgerAction.Append.parse({
          id: "action-rollback",
          parentId: null,
          sessionId: row.id,
          kind: "turn",
          intent: encoded("intent"),
          effect: encoded("effect"),
          irreversible: true,
          ts: 11,
        }),
        1,
      ),
    ).toThrow("refuse action");
    expect(stores.session.sessions.get(row.id)?.revision).toBe(1);
    expect(sessionTree(row.id, stores.session.actions).map((node) => node.id)).toEqual([
      `${row.id}:configure`,
    ]);
  });

  test("request action compare-and-set rejects foreign parent and stale revision", () => {
    expect(materialize(sessionRow("request-owner"))).toBe(true);
    const action = LedgerAction.Append.parse({
      id: "request",
      parentId: "missing",
      sessionId: "request-owner",
      kind: "request",
      intent: encoded("original"),
      effect: encoded("open"),
      irreversible: true,
      ts: 1,
    });
    expect(stores.session.actions.append(action, 1)).toBeUndefined();
    expect(stores.session.actions.append({ ...action, parentId: null }, 2)).toBeUndefined();
    expect(stores.session.sessions.get("request-owner")?.revision).toBe(1);
    expect(sessionTree("request-owner", stores.session.actions).map((node) => node.id)).toEqual([
      "request-owner:configure",
    ]);
  });

  test("canonical session reads cannot mutate a later snapshot", () => {
    expect(materialize(sessionRow("session-isolated"))).toBe(true);
    const first = stores.session.sessions.get("session-isolated");
    if (first === undefined) throw new Error("missing session");
    first.revision = 99;
    expect(stores.session.sessions.get(first.id)?.revision).toBe(1);
  });
});
