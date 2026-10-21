import { sessionTree } from "../helpers/session-tree";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import { z } from "zod";
import { parsePlainJson, readPlainJson } from "../../../src/core/store/storage/sqlite-l0-rows";
import { testExecutor } from "../../helpers/executor";
import { allowAllPolicy } from "../../helpers/compiled-policy";
import { requestLedger } from "../../helpers/effect-g1";
import { isolated, isolatedLedger } from "../../helpers/isolated";
import { PlainObjectSchema } from "@oni/protocol";
import { createSqliteDecisionFacts } from "../../../src/core/store/decision";
import {
  materializeRow,
  openLedgerDatabase,
  observedL0Adapters,
  residentRow,
} from "../helpers/ledger";

test("raw recorded facts reject malformed JSON and non-finite JSON numbers", () => {
  using db = openLedgerDatabase();
  const facts = createSqliteDecisionFacts(db);
  facts.record({ key: "boundary", type: "test", data: {}, timeCreated: 1 });
  // Malformed text is the typed json refusal; "1e999" is valid JSON that the
  // plain-value schema rejects, so its boundary is the native parser error.
  const malformed = expect.objectContaining({ _tag: "SchemaRefused", reason: "json" });
  for (const [corrupt, refusal] of [["{", malformed], ["1e999", z.ZodError]] as const) {
    db.query("UPDATE decision_fact SET data = ? WHERE key = ?").run(corrupt, "boundary");
    expect(() => facts.head("boundary")).toThrow(refusal);
    expect(() =>
      facts.record({ key: "boundary", type: "test", data: {}, timeCreated: 2 }),
    ).toThrow(refusal);
  }
  db.query("UPDATE decision_fact SET data = ? WHERE key = ?").run('{"valid":[1,null]}', "boundary");
  expect(facts.head("boundary")?.data).toEqual({ valid: [1, null] });
});

// The actor-endpoint JSON boundary case moved to
// packages/channels/test/store/actor/endpoint-filters.test.ts with its adapter.

test("action reads validate scalar driver columns and JSON before replay", () => {
  using db = openLedgerDatabase();
  const { adapter: store } = observedL0Adapters(db);
  expect(materializeRow(store.sessions, residentRow("s"))).toBe(true);
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
    1,
  );
  db.run("PRAGMA ignore_check_constraints = ON");
  db.run("UPDATE action SET irreversible = 2");
  expect(() => sessionTree("s", store.actions)).toThrow(z.ZodError);
  expect(() => store.actions.range("s", 0, 10)).toThrow(z.ZodError);
  db.run("UPDATE action SET irreversible = 1, intent = '1e999'");
  expect(() => sessionTree("s", store.actions)).toThrow(z.ZodError);
  db.run("UPDATE action SET intent = '{}'");
  expect(sessionTree("s", store.actions)).toHaveLength(2);
});

// One throwing decoder owns strict JSON reads — malformed text is the
// typed `SchemaRefused{reason: json}`, while syntactically valid JSON that
// violates the plain-value schema keeps its typed schema rejection.
test("parsePlainJson separates malformed JSON from schema-invalid JSON", () => {
  expect(() => parsePlainJson("{")).toThrow(
    expect.objectContaining({ _tag: "SchemaRefused", reason: "json" }),
  );
  // "1e999" is valid JSON syntax decoding to Infinity: the plain-value schema
  // refuses it with its own typed error, never the malformed-json refusal.
  expect(() => parsePlainJson("1e999")).toThrow(z.ZodError);
  expect(parsePlainJson('{"a":[1,null]}')).toEqual({ a: [1, null] });
});

// The degraded companion never throws — corrupt payload text reads as
// `undefined` so callers keep their existing corrupt-row/watch fallbacks.
test("readPlainJson degrades malformed and schema-invalid payloads to undefined", () => {
  expect(readPlainJson("{")).toBeUndefined();
  expect(readPlainJson("1e999")).toBeUndefined();
  expect(readPlainJson('"ok"')).toBe("ok");
});

// A body result crosses the durable boundary as an independent
// copy — mutating the body's own object after `run` resolves changes neither
// the outcome handed back nor the committed result row.
test("a tool result committed by the executor does not alias the body's returned object", () =>
  isolated(
    Effect.gen(function* () {
      const { ledger, identity, clock, entropy } = yield* requestLedger({ id: "alias-session" });
      const executor = testExecutor({
        ledger,
        identity,
        clock,
        entropy,
        random: () => 0,
        policy: allowAllPolicy,
        observations: { publish: () => undefined },
      });
      const returned = { nested: { items: [1, 2] } };
      const outcome = yield* executor.run(
        { kind: "tool", op: "alias", intent: {}, effect: { category: "query" } },
        () => Effect.succeed(returned),
      );
      if (outcome.terminal !== "executed")
        throw new Error(`expected executed, got ${outcome.terminal}`);
      returned.nested.items.push(3);
      expect(outcome.value).toEqual({ nested: { items: [1, 2] } });
      const page = isolatedLedger().kernel.historyPage("alias-session", {
        afterRevision: 0,
        limit: 256,
      });
      const rows = page.actions.filter(
        (action) =>
          action.kind === "tool" && PlainObjectSchema.parse(action.effect.value).phase === "result",
      );
      expect(rows).toHaveLength(1);
      expect(PlainObjectSchema.parse(rows[0]?.effect.value).result).toEqual({
        nested: { items: [1, 2] },
      });
    }),
  ));
