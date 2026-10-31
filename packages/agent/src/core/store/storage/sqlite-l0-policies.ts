import type { Database } from "bun:sqlite";
import { PolicyRow, PlainValueSchema, type PlainValue, type Storage as ProtocolStorage } from "@oni/protocol";
import { z } from "zod";
import { PolicyGenerationRefused } from "../errors.js";
import { PolicySqlRow, decodePolicy } from "./sqlite-l0-rows.js";

const StateRow = z.object({
  key: z.string(),
  revision: z.number().int().positive(),
  value: z.string().transform((value) => PlainValueSchema.parse(JSON.parse(value))),
});

/** Revisioned bundle data shares the catalog's transaction and lifetime. */
export function createPolicyState(db: Database) {
  return {
    get(namespace: string, key: string) {
      return StateRow.nullable().parse(db.query(
        "SELECT key, revision, value FROM policy_state WHERE namespace = ? AND key = ?",
      ).get(namespace, key)) ?? undefined;
    },
    list(namespace: string) {
      return StateRow.array().parse(db.query(
        "SELECT key, revision, value FROM policy_state WHERE namespace = ? ORDER BY key",
      ).all(namespace));
    },
    put(namespace: string, row: { readonly key: string; readonly revision: number; readonly value: PlainValue }): boolean {
      const value = PlainValueSchema.parse(row.value);
      const revision = z.number().int().nonnegative().parse(row.revision);
      return db.query(
        `INSERT INTO policy_state (namespace, key, revision, value)
         SELECT ?, ?, 1, ? WHERE ? = 0
         ON CONFLICT(namespace, key) DO NOTHING`,
      ).run(namespace, row.key, JSON.stringify(value), revision).changes === 1 ||
        db.query(
          "UPDATE policy_state SET revision = revision + 1, value = ? WHERE namespace = ? AND key = ? AND revision = ?",
        ).run(JSON.stringify(value), namespace, row.key, revision).changes === 1;
    },
  };
}

export function createPolicies(
  db: Database,
  transaction: <T>(operation: () => T) => T,
): ProtocolStorage.PolicyRowSubAdapter {
  return {
    appendGeneration(derive) {
      return transaction(() => {
        const all = this.rows();
        const latest = Math.max(0, ...all.map((row) => row.generation));
        const drafts = derive(all.filter((row) => row.generation === latest));
        if (drafts === undefined) return latest;
        const generation = latest + 1;
        if (drafts.length === 0) throw new PolicyGenerationRefused({ generation, reason: "empty" });
        for (const draft of drafts) {
          if (!this.append({ ...draft, generation })) {
            throw new PolicyGenerationRefused({ generation, reason: "conflict", ruleName: draft.name });
          }
        }
        return generation;
      });
    },
    append(input) {
      const row = PolicyRow.Row.parse(input);
      const result = db
        .query(
          `INSERT INTO policy (
             name, kind, phase, match, verdict, encoding_version, priority, generation
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(
          row.name,
          row.kind,
          row.phase,
          JSON.stringify(row.match.value),
          JSON.stringify(row.verdict.value),
          row.match.encodingVersion,
          row.priority,
          row.generation,
        );
      return result.changes === 1;
    },
    rows(generation) {
      const rows = PolicySqlRow.array().parse(
        generation === undefined
          ? db
              .query("SELECT * FROM policy ORDER BY generation, priority DESC, name, kind, phase")
              .all()
          : db
              .query(
                "SELECT * FROM policy WHERE generation = ? ORDER BY priority DESC, name, kind, phase",
              )
              .all(generation),
      );
      return rows.map(decodePolicy);
    },
  };
}
