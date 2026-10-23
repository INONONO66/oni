import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { openSessionStore } from "../../src/core/store/session-file";
import { runTestPromise } from "../helpers/isolated";
import { DecisionFact } from "@oni/protocol";
import { createDecisionFactPort } from "../../src/core/store/decision";
import { testNow, useMemoryStores } from "./helpers/storage";

const stores = useMemoryStores();

const input = {
  key: "route:first",
  type: "route.decided",
  data: { value: "a|b" },
  timeCreated: 10,
};

test("first writer wins and every outcome carries the exact recorded fact", () => {
  const facts = stores.session.decisionFacts;
  expect(facts.head(input.key)).toBeUndefined();
  const first = facts.record(input);
  expect(first).toEqual({
    kind: "recorded",
    fact: input,
  });
  expect(DecisionFact.Outcome.parse(first)).toEqual(first);
  expect(
    facts.record({ ...input, type: "other", data: { changed: true }, timeCreated: 20 }),
  ).toEqual({ kind: "exists", fact: first.fact });
  expect(facts.head(input.key)).toEqual(first.fact);
});

test("decision facts share the store transaction and roll back with it", () => {
  const port = createDecisionFactPort(stores.session);
  const failure = new Error("rollback");
  expect(() =>
    port.transaction(() => {
      expect(port.port()?.record(input).kind).toBe("recorded");
      throw failure;
    }),
  ).toThrow(failure);
  expect(stores.session.decisionFacts.head(input.key)).toBeUndefined();
  stores.session.transaction(() =>
    expect(stores.session.decisionFacts.record(input).kind).toBe("recorded"),
  );
  expect(stores.session.decisionFacts.head(input.key)?.data).toEqual(input.data);
});

test("decision facts keep fractional epoch instants without rounding", () => {
  const facts = stores.session.decisionFacts;
  const outcome = facts.record({ ...input, key: "route:fractional", timeCreated: 1.5 });
  expect(outcome.kind).toBe("recorded");
  if (outcome.kind !== "recorded") throw new Error("expected recorded outcome");
  expect(outcome.fact.timeCreated).toBe(1.5);
  expect(facts.head("route:fractional")?.timeCreated).toBe(1.5);
});

// The ORM schema file is gone; the contract is proven by a
// real round-trip through Effect `SqlClient` against the store's own file.
test("decision_fact rows round-trip through Effect SqlClient in both directions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "decision-fact-sql-"));
  const path = join(directory, "session.sqlite");
  try {
    const store = openSessionStore(path, { now: testNow });
    const recorded = store.transaction(() => store.decisionFacts.record(input));
    expect(recorded.kind).toBe("recorded");
    if (recorded.kind !== "recorded") throw new Error("expected recorded outcome");
    store.close();

    type SqlRow = { key: string; type: string; data: string; time_created: number };
    const sqlLayer = SqliteClient.layer({ filename: path });
    const rows = await runTestPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const read = yield* sql<SqlRow>`
          SELECT key, type, data, time_created
          FROM decision_fact WHERE key = ${input.key}`;
        yield* sql`
          INSERT INTO decision_fact (key, type, data, time_created)
          VALUES ('route:sql', 'route.decided', '{"via":"sql"}', 20)`;
        return read;
      }).pipe(Effect.provide(sqlLayer)),
    );
    expect(rows).toEqual([
      {
        key: input.key,
        type: input.type,
        data: JSON.stringify(input.data),
        time_created: input.timeCreated,
      },
    ]);

    const reopened = openSessionStore(path, { now: testNow });
    try {
      expect(reopened.decisionFacts.head("route:sql")).toEqual(
        DecisionFact.Recorded.parse({
          key: "route:sql",
          type: "route.decided",
          data: { via: "sql" },
          timeCreated: 20,
        }),
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});
