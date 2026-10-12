import { sessionTree } from "../helpers/session-tree";
import { Effect, Result } from "effect";
import { runLedgerSync } from "../helpers/effect";
import { expect, test } from "bun:test";
import { parsePlainJson, readPlainJson } from "../../../src/core/store/json";
import { clonePlainValue } from "../../../src/core/gate/decide";
import { SchemaRefused } from "../../../src/core/store/errors";
import { LedgerSession } from "@openomni/protocol";
import { createSqliteDecisionFacts } from "../../../src/core/store/decision";
import { openLedgerDatabase, observedL0Adapters } from "../helpers/ledger";

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

// #1344: one throwing decoder owns strict JSON reads — malformed text is the
// typed `SchemaRefused{reason: json}`, while syntactically valid JSON that
// violates the plain-value schema keeps its typed schema rejection.
test("parsePlainJson separates malformed JSON from schema-invalid JSON", () => {
  expect(() => parsePlainJson("{")).toThrow(
    expect.objectContaining({ _tag: "SchemaRefused", reason: "json" }),
  );
  // "1e999" is valid JSON syntax decoding to Infinity: the plain-value schema
  // refuses it with its own typed error, never the malformed-json refusal.
  let schemaRejection: unknown;
  try { parsePlainJson("1e999"); } catch (cause) { schemaRejection = cause; }
  expect(schemaRejection).toBeDefined();
  expect(schemaRejection instanceof SchemaRefused).toBe(false);
  expect(parsePlainJson('{"a":[1,null]}')).toEqual({ a: [1, null] });
});

// #1344: the degraded companion never throws — corrupt payload text reads as
// `undefined` so callers keep their existing corrupt-row/watch fallbacks.
test("readPlainJson degrades malformed and schema-invalid payloads to undefined", () => {
  expect(readPlainJson("{")).toBeUndefined();
  expect(readPlainJson("1e999")).toBeUndefined();
  expect(readPlainJson('"ok"')).toBe("ok");
});

// #1344: clonePlainValue stays a JSON round-trip because callers need an
// independent copy — mutating the admitted copy must not touch the original.
test("clonePlainValue copies do not alias the original plain value", () => {
  const original = { nested: { items: [1, 2] } };
  const copy = clonePlainValue(original) as { nested: { items: number[] } };
  copy.nested.items.push(3);
  expect(original.nested.items).toEqual([1, 2]);
  expect(copy.nested.items).toEqual([1, 2, 3]);
});
