import type { Database } from "bun:sqlite";
import { PolicyRow, type Storage as ProtocolStorage } from "@oni/protocol";
import { PolicyGenerationRefused } from "../errors.js";
import { PolicySqlRow, decodePolicy } from "./sqlite-l0-rows.js";

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
