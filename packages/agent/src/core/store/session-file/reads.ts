import type { Database } from "bun:sqlite";
import { Journal, type LedgerAction, SessionTransition, type ObservationSink, type Storage } from "@oni/protocol";
import { z } from "zod";
import { thrownAsError } from "../../ports/failure";
import { LedgerInvariant } from "../errors";
import { parsePlainJson } from "../storage/sqlite-l0-rows";
import { ActionSqlRow, decodeAction } from "../storage/sqlite-l0-rows.js";

const pageSize = z.number().int().positive().max(256);
const windowCount = z.number().int().nonnegative();
const OrdinalRow = z.object({ ordinal: z.number().int().positive() }).nullable();
const PayloadBytesRow = z.object({ bytes: z.number().int().nonnegative() });
const PolicyDecisionIntentRow = z.object({ intent: z.string() }).nullable();
const PolicyDecisionIdentityRow = z.object({ matchedRuleIds: z.array(z.string()) });
type Reads = Omit<Storage.ActionSubAdapter, "append" | "verifyChain">;

export const PENDING_MESSAGES_SQL = `
  SELECT a.* FROM action a WHERE a.session_id = ? AND a.kind IN ('prompt', 'signal', 'action')
    AND json_extract(a.effect, '$.deliveryKind') IS NOT NULL
    AND a.id NOT IN (SELECT json_extract(d.intent, '$.deliveryId') FROM action d
      WHERE d.session_id = ? AND d.kind IN ('prompt', 'signal', 'action')
        AND json_extract(d.intent, '$.deliveryId') IS NOT NULL)
    AND a.id NOT IN (SELECT stale.value FROM action t, json_each(t.intent, '$.consumedStale') stale
      WHERE t.session_id = ? AND t.kind = 'turn' AND json_valid(t.intent)
        AND stale.value IS NOT NULL)
  ORDER BY a.ordinal`;

export const OUTBOUND_STATES_SQL = `
  SELECT a.* FROM action a WHERE a.session_id = ? AND a.kind = 'message'
    AND json_extract(a.intent, '$.op') IN ('open', 'ack')
    AND coalesce(json_extract(a.effect, '$.outbound.message.messageId'), a.id) > ?
    AND (json_extract(a.effect, '$.outbound.message.messageId') IS NULL
      OR a.ordinal = (SELECT max(b.ordinal) FROM action b WHERE b.session_id = a.session_id
        AND b.kind = 'message' AND json_extract(b.intent, '$.op') IN ('open', 'ack')
        AND json_extract(b.effect, '$.outbound.message.messageId') =
          json_extract(a.effect, '$.outbound.message.messageId')))
  ORDER BY coalesce(json_extract(a.effect, '$.outbound.message.messageId'), a.id) LIMIT ?`;

/** Read degradation (): a row that fails decode is kept verbatim on disk, */
function reportCorruptRow(row: ActionSqlRow, sink: ObservationSink, cause: Error): void {
  try {
    sink.publish(Journal.CorruptEvent, { seq: row.ordinal, kind: row.kind, reason: cause.message });
  } catch {
    // Post-read observation must never block the degraded read itself.
  }
}

function decodeActionDegraded(
  row: ActionSqlRow,
  sink: ObservationSink,
): LedgerAction.Node | undefined {
  try {
    return decodeAction(row);
  } catch (cause) {
    reportCorruptRow(row, sink, thrownAsError(cause));
    try {
      return decodeAction({
        ...row,
        intent: JSON.stringify(row.intent),
        effect: JSON.stringify(row.effect),
        revert: null,
      });
    } catch {
      return undefined;
    }
  }
}

/**
 * Projection reads degrade by exclusion (): a corrupt row emits the same
 * single `journal.corrupt{seq, kind, reason}` observation as the fold path and
 * is skipped — the port answers instead of throwing. The fold (`range`) keeps
 * the opaque shape instead because the report view must show every row.
 */
function decodeOneDegraded(
  value: ActionSqlRow | null,
  sink: ObservationSink,
): LedgerAction.Node | undefined {
  const row = ActionSqlRow.nullable().parse(value);
  if (row === null) return undefined;
  try {
    return decodeAction(row);
  } catch (cause) {
    reportCorruptRow(row, sink, thrownAsError(cause));
    return undefined;
  }
}

function decodeRowsDegraded(values: ActionSqlRow[], sink: ObservationSink): LedgerAction.Node[] {
  return ActionSqlRow.array().parse(values).flatMap((row) => {
    try {
      return [decodeAction(row)];
    } catch (cause) {
      reportCorruptRow(row, sink, thrownAsError(cause));
      return [];
    }
  });
}

/** Each semantic port owns a literal statement and explicit bindings. */
export function createActionReads(db: Database, sink: ObservationSink): Reads {
  const decodeOne = (value: ActionSqlRow | null) => decodeOneDegraded(value, sink);
  const decodeRows = (values: ActionSqlRow[]) => decodeRowsDegraded(values, sink);
  return {
    priorModelAttempt(sessionId, turnId) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string, string, string]>(`
        SELECT a.* FROM action a JOIN action llm ON llm.id = a.parent_id
        LEFT JOIN action turn ON turn.id = llm.parent_id
        WHERE a.session_id = ? AND a.kind = 'llm'
          AND json_extract(a.intent, '$.phase') = 'intent'
          AND json_extract(a.intent, '$.attempt') IS NOT NULL
          AND json_extract(a.intent, '$.op') = 'chat' AND llm.parent_id != ?
          AND coalesce(json_extract(turn.intent, '$.turnId'), '') != ?
        ORDER BY a.ordinal DESC LIMIT 1`)
          .get(sessionId, turnId, turnId),
      );
    },
    generationFor(sessionId, generation) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string, number]>(`
        SELECT * FROM action WHERE session_id = ? AND kind = 'session.configure'
          AND json_valid(effect) AND json_extract(effect, '$.snapshot.generation') = ?
        ORDER BY ordinal DESC LIMIT 1`)
          .get(sessionId, generation),
      );
    },
    turnTerminalFor(sessionId, turnId) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string, string]>(`
        SELECT * FROM action WHERE session_id = ? AND kind = 'turn'
          AND json_extract(effect, '$.phase') = 'terminal'
          AND json_extract(effect, '$.turnId') = ?
        ORDER BY ordinal DESC LIMIT 1`)
          .get(sessionId, turnId),
      );
    },
    latestTurnTerminal(sessionId) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string]>(`
        SELECT * FROM action WHERE session_id = ? AND kind = 'turn'
          AND json_extract(effect, '$.phase') = 'terminal'
        ORDER BY ordinal DESC LIMIT 1`)
          .get(sessionId),
      );
    },
    latestTurnUpdate(sessionId, turnId) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string, string, string]>(`
        SELECT * FROM action WHERE session_id = ? AND kind = 'turn'
          AND (json_extract(intent, '$.turnId') = ? OR json_extract(effect, '$.turnId') = ?)
        ORDER BY ordinal DESC LIMIT 1`)
          .get(sessionId, turnId, turnId),
      );
    },
    turnIntentsPage(sessionId, beforeRevision, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, number, number]>(`
        SELECT * FROM action WHERE session_id = ? AND kind = 'turn'
          AND json_extract(intent, '$.phase') = 'intent' AND ordinal < ?
        ORDER BY ordinal DESC LIMIT ?`)
          .all(sessionId, beforeRevision, pageSize.parse(limit)),
      );
    },
    turnWindowStart(sessionId, beforeRevision, count) {
      const row = OrdinalRow.parse(
        db
          .query<{ ordinal: number }, [string, number, number]>(`
        SELECT ordinal FROM action WHERE session_id = ? AND kind = 'turn'
          AND json_extract(intent, '$.phase') = 'intent' AND ordinal < ?
        ORDER BY ordinal DESC LIMIT 1 OFFSET ?`)
          .get(sessionId, beforeRevision, windowCount.parse(count)),
      );
      return row === null ? 0 : row.ordinal;
    },
    turnTailPage(sessionId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, number, number]>(`
        SELECT * FROM action WHERE session_id = ? AND kind IN ('turn', 'prompt', 'signal', 'action')
          AND ordinal > ?
        ORDER BY ordinal LIMIT ?`)
          .all(sessionId, cursor, pageSize.parse(limit)),
      );
    },
    openTurnsPage(sessionId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, number, string, number]>(`
        SELECT a.* FROM action a WHERE a.session_id = ? AND a.kind = 'turn'
          AND json_extract(a.intent, '$.phase') = 'intent' AND a.ordinal > ?
          AND a.id NOT IN (SELECT json_extract(effect, '$.turnId') FROM action
            WHERE session_id = ? AND kind = 'turn'
            AND json_extract(effect, '$.phase') = 'terminal'
            AND json_extract(effect, '$.turnId') IS NOT NULL)
        ORDER BY a.ordinal LIMIT ?`)
          .all(sessionId, cursor, sessionId, pageSize.parse(limit)),
      );
    },
    resultFor(sessionId, parentId) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string, string]>(`
        SELECT * FROM action WHERE session_id = ? AND parent_id = ? AND kind != 'fold.checkpoint'
          AND json_extract(effect, '$.phase') = 'result'
        ORDER BY ordinal DESC LIMIT 1`)
          .get(sessionId, parentId),
      );
    },
    requestInputById(sessionId, inputId) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string, string]>(`
        SELECT * FROM action WHERE session_id = ? AND kind = 'request'
          AND json_extract(intent, '$.inputId') = ?
        ORDER BY ordinal DESC LIMIT 1`)
          .get(sessionId, inputId),
      );
    },
    requestStateById(id) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string]>(`
        SELECT * FROM action WHERE kind = 'request'
          AND json_extract(effect, '$.request.requestId') = ?
        ORDER BY rowid DESC LIMIT 1`)
          .get(id),
      );
    },
    requestStatesPage(sessionId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string | null, string | null, string, number]>(`
        SELECT a.* FROM action a WHERE a.kind = 'request'
          AND (? IS NULL OR a.session_id = ?) AND json_extract(a.effect, '$.request.requestId') > ?
          AND a.rowid = (SELECT max(b.rowid) FROM action b WHERE b.kind = 'request'
            AND json_extract(b.effect, '$.request.requestId') = json_extract(a.effect, '$.request.requestId'))
        ORDER BY json_extract(a.effect, '$.request.requestId') LIMIT ?`)
          .all(sessionId ?? null, sessionId ?? null, cursor, pageSize.parse(limit)),
      );
    },
    outboundStatesPage(sessionId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, string, number]>(OUTBOUND_STATES_SQL)
          .all(sessionId, cursor, pageSize.parse(limit)),
      );
    },
    guardedOperationsPage(sessionId, turnId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, number, string, number]>(`
        SELECT a.* FROM action a WHERE a.session_id = ? AND a.ordinal > ?
          AND EXISTS (SELECT 1 FROM action member WHERE member.session_id = a.session_id
            AND member.kind = 'tool' AND json_extract(member.intent, '$.phase') = 'intent'
            AND (a.id = member.id OR a.parent_id = member.id)
            AND EXISTS (SELECT 1 FROM action guarded WHERE guarded.session_id = member.session_id
              AND guarded.kind = 'tool' AND json_extract(guarded.intent, '$.turnId') = ?
              AND json_extract(guarded.intent, '$.approvalRequired') = 1
              AND json_extract(guarded.intent, '$.waveId') = json_extract(member.intent, '$.waveId'))
            AND EXISTS (SELECT 1 FROM action unfinished WHERE unfinished.session_id = member.session_id
              AND unfinished.kind = 'tool' AND json_extract(unfinished.intent, '$.phase') = 'intent'
              AND json_extract(unfinished.intent, '$.waveId') = json_extract(member.intent, '$.waveId')
              AND NOT EXISTS (SELECT 1 FROM action settled WHERE settled.session_id = unfinished.session_id
                AND settled.parent_id = unfinished.id AND settled.kind != 'fold.checkpoint'
                AND json_extract(settled.effect, '$.phase') = 'result')))
        ORDER BY a.ordinal LIMIT ?`)
          .all(sessionId, cursor, turnId, pageSize.parse(limit)),
      );
    },
    openOperationsPage(sessionId, turnId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, number, string, string, string, number]>(`
        SELECT a.* FROM action a WHERE a.session_id = ? AND a.ordinal > ?
          AND a.kind IN ('llm', 'message', 'compaction', 'tool')
          AND json_extract(a.intent, '$.phase') = 'intent'
          AND (a.parent_id = ? OR json_extract(a.intent, '$.turnId') = ?
            OR a.parent_id IN (SELECT id FROM action WHERE session_id = a.session_id AND kind = 'turn'
              AND json_extract(intent, '$.phase') = 'resume' AND json_extract(intent, '$.turnId') = ?))
          AND NOT EXISTS (SELECT 1 FROM action WHERE session_id = a.session_id AND parent_id = a.id
            AND kind != 'fold.checkpoint' AND json_extract(effect, '$.phase') = 'result')
          AND (a.kind != 'tool' OR NOT EXISTS (SELECT 1 FROM action guarded
            WHERE guarded.session_id = a.session_id
              AND json_extract(guarded.intent, '$.waveId') = json_extract(a.intent, '$.waveId')
              AND json_extract(guarded.intent, '$.approvalRequired') = 1))
        ORDER BY a.ordinal LIMIT ?`)
          .all(sessionId, cursor, turnId, turnId, turnId, pageSize.parse(limit)),
      );
    },
    operationChildrenPage(sessionId, parentId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, string, number, number]>(`
        SELECT * FROM action WHERE session_id = ? AND parent_id = ? AND ordinal > ?
        ORDER BY ordinal LIMIT ?`)
          .all(sessionId, parentId, cursor, pageSize.parse(limit)),
      );
    },
    pendingMessages(sessionId) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, string, string]>(PENDING_MESSAGES_SQL)
          .all(sessionId, sessionId, sessionId),
      );
    },
    latestCompaction(sessionId) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string]>(`
        SELECT * FROM action WHERE session_id = ? AND kind = 'compaction'
          AND json_extract(effect, '$.terminal') = 'executed'
        ORDER BY ordinal DESC LIMIT 1`)
          .get(sessionId),
      );
    },
    // : the SQL replacement for the retired received-message TS re-fold.
    inputMessages(sessionId) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string]>(`
        SELECT a.* FROM action a WHERE a.session_id = ? AND a.kind IN ('prompt', 'signal', 'action')
          AND json_extract(a.effect, '$.deliveryKind') IS NOT NULL
        ORDER BY a.ordinal`)
          .all(sessionId),
      );
    },


    actionById(id) {
      const row = ActionSqlRow.nullable().parse(
        db.query("SELECT * FROM action WHERE id = ?").get(id),
      );
      return row === null ? undefined : decodeAction(row);
    },
    latestAction(sessionId, throughRevision) {
      const row = ActionSqlRow.nullable().parse(
        db
          .query(
            "SELECT * FROM action WHERE session_id = ? AND ordinal <= ? ORDER BY ordinal DESC LIMIT 1",
          )
          .get(sessionId, throughRevision),
      );
      return row === null ? undefined : decodeAction(row);
    },
    latestFoldCheckpoint(sessionId, throughRevision) {
      const row = ActionSqlRow.nullable().parse(
        db
          .query(
            "SELECT * FROM action WHERE session_id = ? AND kind = 'fold.checkpoint' AND ordinal <= ? ORDER BY ordinal DESC LIMIT 1",
          )
          .get(sessionId, throughRevision),
      );
      return row === null ? undefined : decodeAction(row);
    },
    payloadBytes(sessionId, afterRevision, throughRevision) {
      // The stored TEXT columns are the exact `JSON.stringify` strings `actionPayloadBytes` measures.
      return PayloadBytesRow.parse(
        db
          .query(
            `SELECT COALESCE(SUM(
               length(CAST(intent AS BLOB)) + length(CAST(effect AS BLOB)) + COALESCE(length(CAST(revert AS BLOB)), 0)
             ), 0) AS bytes
             FROM action WHERE session_id = ? AND ordinal > ? AND ordinal <= ?`,
          )
          .get(sessionId, afterRevision, throughRevision),
      ).bytes;
    },
    configurationActions(sessionId, beforeRevision) {
      const rows = ActionSqlRow.array().parse(
        db
          .query(
            "SELECT * FROM action WHERE session_id = ? AND kind = 'session.configure' AND ordinal < ? ORDER BY ordinal DESC LIMIT 1",
          )
          .all(sessionId, beforeRevision),
      );
      return rows.map(decodeAction);
    },
    policyDecisionRuleIds(sessionId, inputHash) {
      const row = PolicyDecisionIntentRow.parse(
          db
            .query(
              `SELECT intent FROM action WHERE session_id = ? AND kind = 'policy.decision'
           AND json_extract(intent, '$.inputHash') = ? ORDER BY ordinal DESC LIMIT 1`,
            )
            .get(sessionId, inputHash),
        );
      if (row === null) return undefined;
      const parsed = PolicyDecisionIdentityRow.safeParse(parsePlainJson(row.intent));
      if (!parsed.success)
        throw new LedgerInvariant({
          operation: "policy.decision",
          message: "invalid message decision rule identity",
          cause: parsed.error,
        });
      return parsed.data.matchedRuleIds;
    },
    messageActionByPlatformId(sessionId, messageId) {
      const row = ActionSqlRow.nullable().parse(
        db
          .query(
            `SELECT * FROM action WHERE session_id = ? AND kind = 'message'
           AND json_extract(intent, '$.value.messageId') = ? ORDER BY ordinal LIMIT 1`,
          )
          .get(sessionId, messageId),
      );
      return row === null ? undefined : decodeAction(row);
    },
    outboundReceipt(destinationSessionId, messageId) {
      const rows = ActionSqlRow.array().parse(
        db
          .query(
            `SELECT * FROM action WHERE session_id = ? AND kind = 'prompt' AND id = ?
           UNION ALL
           SELECT * FROM action WHERE session_id = ? AND kind = 'request'
           AND json_extract(effect, '$.phase') = 'answered'
           AND json_extract(effect, '$.answer.outbound.messageId') = ? ORDER BY ordinal`,
          )
          .all(destinationSessionId, messageId, destinationSessionId, messageId),
      );
      for (const row of rows) {
        const action = decodeAction(row);
        if (action.kind === "request") {
          const effect = action.effect.value;
          if (effect === null || typeof effect !== "object" || Array.isArray(effect)) continue;
          const answer = SessionTransition.Answer.safeParse(effect.answer);
          if (!answer.success) continue;
        }
        return { action, revision: action.ordinal };
      }
      return undefined;
    },
    range(sessionId, afterRevision, limit) {
      const pageLimit = z.number().int().positive().max(256).parse(limit);
      const rows = ActionSqlRow.array().parse(
        db
          .query(
            `SELECT id, parent_id, session_id, kind, intent, effect, revert,
                  irreversible, encoding_version, ts, ordinal, prev_hash, action_hash
           FROM action WHERE session_id = ? AND ordinal > ? ORDER BY ordinal LIMIT ?`,
          )
          .all(sessionId, afterRevision, pageLimit),
      );
      return rows.flatMap((row) => {
        const action = decodeActionDegraded(row, sink);
        return action === undefined ? [] : [action];
      });
    },
  };
}
