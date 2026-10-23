import type { Database } from "bun:sqlite";
import { DecisionFact, type Storage, type Storage as ProtocolStorage } from "@oni/protocol";
import { z } from "zod";
import { parsePlainJson } from "./storage/sqlite-l0-rows";

namespace DecisionFacts {
  export type Port = ProtocolStorage.DecisionFactSubAdapter;

  export interface Source {
    readonly decisionFacts?: Port;
    transaction<T>(operation: () => T): T;
  }
}

/** The perimeter injects the handle whose transaction boundary its admission unit runs in. */
export function createDecisionFactPort(source: DecisionFacts.Source): {
  transaction<T>(operation: () => T): T;
  port(): DecisionFacts.Port | undefined;
} {
  return {
    transaction: (operation) => source.transaction(operation),
    port: () => source.decisionFacts,
  };
}

const SqliteRow = z.object({
  key: z.string(),
  type: z.string(),
  data: z.string(),
  time_created: z.number(),
});

const Row = SqliteRow.transform((row: z.infer<typeof SqliteRow>) =>
  DecisionFact.Recorded.parse({
    key: row.key,
    type: row.type,
    data: parsePlainJson(row.data),
    timeCreated: row.time_created,
  }),
);

export function createSqliteDecisionFacts(db: Database): Storage.DecisionFactSubAdapter {
  function head(key: string): DecisionFact.Recorded | undefined {
    const row = db.query("SELECT * FROM decision_fact WHERE key = ?").get(key);
    return row === null ? undefined : Row.parse(row);
  }

  return {
    head,
    record(input) {
      const parsed = DecisionFact.Record.parse(input);
      const data = JSON.stringify(parsed.data);
      return db
        .transaction((): DecisionFact.Outcome => {
          const result = db
            .query(
              "INSERT OR IGNORE INTO decision_fact (key, type, data, time_created) VALUES (?, ?, ?, ?)",
            )
            .run(parsed.key, parsed.type, data, parsed.timeCreated);
          const fact = Row.parse(
            db.query("SELECT * FROM decision_fact WHERE key = ?").get(parsed.key),
          );
          return { kind: result.changes === 1 ? "recorded" : "exists", fact };
        })
        .immediate();
    },
  };
}
