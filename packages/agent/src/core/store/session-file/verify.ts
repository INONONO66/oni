import type { Database } from "bun:sqlite";
import type { LedgerAction } from "@openomni/protocol";
import { z } from "zod";
import { computeActionHash, GENESIS_PREV_HASH } from "../action-hash.js";
import { ActionSqlRowSafeIntegers } from "../storage/sqlite-l0-rows.js";

/** Any stored representation SQLite admits into a TEXT hash column; only a string can verify. */
const HashCell = z.union([z.string(), z.null(), z.number(), z.bigint(), z.instanceof(Uint8Array)]);

function describeHashCell(cell: z.infer<typeof HashCell>): string {
  if (cell instanceof Uint8Array) return `blob:${Buffer.from(cell).toString("hex")}`;
  return String(cell);
}

const VerifyRow = ActionSqlRowSafeIntegers.extend({ prev_hash: HashCell, action_hash: HashCell });

export function verifyChain(db: Database, sessionId: string): LedgerAction.ChainVerdict {
  const rows = VerifyRow.array().parse(
    db.query("SELECT * FROM action WHERE session_id = ? ORDER BY ordinal").all(sessionId),
  );
  let prevHash = GENESIS_PREV_HASH;
  for (const row of rows) {
    if (row.prev_hash !== prevHash) {
      return {
        kind: "broken",
        ordinal: row.ordinal,
        expected: prevHash,
        actual: describeHashCell(row.prev_hash),
      };
    }
    const expected = computeActionHash({ ...row, prev_hash: prevHash });
    if (row.action_hash !== expected) {
      return {
        kind: "broken",
        ordinal: row.ordinal,
        expected,
        actual: describeHashCell(row.action_hash),
      };
    }
    prevHash = expected;
  }
  return { kind: "intact", head: rows.length === 0 ? null : prevHash, length: rows.length };
}
