import { sessionTree } from "../helpers/session-tree";
import { Effect, Result } from "effect";
import { runLedgerSync } from "../helpers/effect";
import { expect, test } from "bun:test";
import { LedgerSession } from "@openomni/protocol";
import { createSqliteDecisionFacts } from "../../../src/core/store/decision";
import { SchemaRefused } from "../../../src/core/store/errors";
import { parsePlainJson } from "../../../src/core/store/json";
import { openLedgerDatabase, observedL0Adapters } from "../helpers/ledger";

test("plain JSON syntax refuses with a typed json reason; schema failures remain distinct", () => {
  expect(() => parsePlainJson("{")).toThrow(expect.objectContaining({ _tag: "SchemaRefused", reason: "json" }));
  try {
    parsePlainJson("{");
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaRefused);
    expect(error).not.toBeInstanceOf(SyntaxError);
  }
  expect(() => parsePlainJson("1e999")).toThrow();
  expect(() => parsePlainJson("1e999")).not.toThrow(SchemaRefused);
  expect(parsePlainJson('{"valid":[1,null]}')).toEqual({ valid: [1, null] });
});

test("raw recorded facts reject malformed JSON and non-finite JSON numbers", () => {
  using db = openLedgerDatabase();
  const facts = createSqliteDecisionFacts(db);
  facts.record({ key: "boundary", type: "test", data: {}, timeCreated: 1 });
  for (const corrupt of ["{", "1e999"]) {
    db.query("UPDATE decision_fact SET data = ? WHERE key = ?").run(corrupt, "boundary");
    expect(() => facts.head("boundary")).toThrow();
    expect(() =>
      facts.record({ key: "boundary", type: "test", data: {}, timeCreated: 2 }),
    ).toThrow();
  }
  db.query("UPDATE decision_fact SET data = ? WHERE key = ?").run('{"valid":[1,null]}', "boundary");
  expect(facts.head("boundary")?.data).toEqual({ valid: [1, null] });
});

// The actor-endpoint JSON boundary case moved to
// packages/channels/test/store/actor/endpoint-filters.test.ts with its adapter (#1317).

test("action reads validate scalar driver columns and JSON before replay", () => {
  using db = openLedgerDatabase();
  const { adapter: store } = observedL0Adapters(db);
  Result.getOrThrowWith(
    runLedgerSync(
      Effect.result(
        store.sessions.create(
          LedgerSession.Row.parse({
            id: "s",
            parentId: null,
            role: "resident",
            fenceOwner: null,
            fence: 0,
            revision: 0,
            state: "idle",
          }),
        ),
      ),
    ),
    (error) => error,
  );
  store.actions.append(
    {
      id: "a",
      parentId: null,
      sessionId: "s",
      kind: "tool",
      intent: { encodingVersion: 1, value: {} },
      effect: { encodingVersion: 1, value: {} },
      irreversible: true,
      ts: 1,
    },
    0,
  );
  db.run("PRAGMA ignore_check_constraints = ON");
  db.run("UPDATE action SET irreversible = 2");
  expect(() => sessionTree("s", store.actions)).toThrow();
  expect(() => store.actions.range("s", 0, 10)).toThrow();
  db.run("UPDATE action SET irreversible = 1, intent = '1e999'");
  expect(() => sessionTree("s", store.actions)).toThrow();
  db.run("UPDATE action SET intent = '{}'");
  expect(sessionTree("s", store.actions)).toHaveLength(1);
});
