import { Database } from "bun:sqlite";
import { parsePlainJson } from "../json";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  canonicalJson,
  Journal,
  LedgerAction,
  LedgerSession,
  PlainObjectSchema,
  SessionTransition,
  type ObservationSink,
  type Storage,
  type Storage as ProtocolStorage,
  V1_DELIVERY_FIELDS,
} from "@openomni/protocol";

/**
 * #1315 versioned read: rows persisted before the prompt/signal v2 bump name
 * the delivered input under the retired field names. The SQL projections
 * coalesce both spellings; the legacy paths come from the protocol's
 * versioned reader so no retired token is spelled here.
 */
const legacyIdPath = `'$.${V1_DELIVERY_FIELDS.id}'`;
const legacyKindPath = `'$.${V1_DELIVERY_FIELDS.kind}'`;
import { z } from "zod";
import { CorruptRecord, LedgerInvariant, MaterializeRefused, type LedgerError } from "../errors";
import { computeActionHash, GENESIS_PREV_HASH } from "../action-hash.js";
import type { SessionWriteAdapter } from "../services";
import { createSqliteDecisionFacts } from "../decision.js";
import { ActionSqlRow, ActionSqlRowSafeIntegers, decodeAction } from "../storage/sqlite-l0-rows.js";
import { appendAction, commitSession, insertSession, selectSession } from "../storage/sqlite-l0-write.js";
import { createSessions, materializeSession } from "../storage/sqlite-l0-sessions.js";
import { writeEffect, type RefuseWrite } from "../storage/write-effect.js";
import type { Effect } from "effect";
import { reportCommitted, type ObservationFailurePort } from "../storage/sqlite-l0-observation.js";
import { thrownAsError } from "../../failure";


export { computeActionHash, GENESIS_PREV_HASH } from "../action-hash.js";

/**
 * Fresh per-session ledger file DDL (W5.2 #1197) — the only session-file
 * schema owner. One file per session holds exactly three tables: the single
 * session row, the append-only action hash chain (0041 shape), and
 * first-writer-wins decision facts (0040 shape). There is no migration plane:
 * a session file is either fresh or already on this schema.
 */
export const SESSION_FILE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    role TEXT CHECK (role IN ('resident', 'child')),
    lease_owner TEXT,
    lease_fence INTEGER NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running', 'interrupted')),
    tools_generation INTEGER NOT NULL DEFAULT 0 CHECK (tools_generation >= 0),
    system_hash TEXT NOT NULL DEFAULT '',
    policy_generation INTEGER NOT NULL DEFAULT 0 CHECK (policy_generation >= 0)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_role_not_null
     ON session(id) WHERE role IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS action (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES action(id),
    session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN (
      'prompt', 'signal', 'turn', 'llm', 'message', 'request', 'alarm',
      'session.configure', 'policy.decision', 'tool', 'compaction', 'action',
      'fold.checkpoint'
    )),
    intent TEXT NOT NULL CHECK (json_valid(intent)),
    effect TEXT NOT NULL CHECK (json_valid(effect)),
    revert TEXT CHECK (revert IS NULL OR json_valid(revert)),
    irreversible INTEGER NOT NULL CHECK (irreversible IN (0, 1)),
    encoding_version INTEGER NOT NULL CHECK (encoding_version = 1),
    ts INTEGER NOT NULL CHECK (ts >= 0),
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    prev_hash TEXT NOT NULL,
    action_hash TEXT NOT NULL,
    CHECK ((revert IS NOT NULL) <> (irreversible = 1)),
    UNIQUE (session_id, ordinal)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS action_hash_unique ON action(action_hash)",
  `CREATE INDEX IF NOT EXISTS idx_action_generation
     ON action(session_id, json_extract(effect, '$.snapshot.generation'), ordinal DESC)
     WHERE kind = 'session.configure' AND json_valid(effect)`,
  `CREATE INDEX IF NOT EXISTS idx_action_input
     ON action(session_id, json_extract(intent, '$.inputId'), ordinal DESC)
     WHERE kind = 'request'`,
  "CREATE INDEX IF NOT EXISTS idx_action_kind_revision ON action(session_id, kind, ordinal DESC)",
  `CREATE INDEX IF NOT EXISTS idx_action_outbound_state
     ON action(session_id, json_extract(effect, '$.outbound.message.messageId'), ordinal DESC)
     WHERE kind = 'message' AND json_extract(intent, '$.op') IN ('open', 'ack')`,
  "CREATE INDEX IF NOT EXISTS idx_action_parent ON action(session_id, parent_id, ordinal)",
  `CREATE INDEX IF NOT EXISTS idx_action_request_state
     ON action(json_extract(effect, '$.request.requestId'))
     WHERE kind = 'request'`,
  `CREATE INDEX IF NOT EXISTS idx_action_turn_effect
     ON action(session_id, json_extract(effect, '$.turnId'), ordinal DESC)
     WHERE kind IN ('turn', 'prompt', 'signal', 'action')`,
  `CREATE INDEX IF NOT EXISTS idx_action_turn_intent
     ON action(session_id, json_extract(intent, '$.phase'), ordinal DESC)
     WHERE kind = 'turn'`,
  `CREATE INDEX IF NOT EXISTS idx_action_turn_resume
     ON action(session_id, json_extract(intent, '$.turnId'), ordinal DESC)
     WHERE kind = 'turn'`,
  `CREATE INDEX IF NOT EXISTS idx_action_turn_terminal
     ON action(session_id, json_extract(effect, '$.turnId'), ordinal DESC)
     WHERE kind = 'turn' AND json_extract(effect, '$.phase') = 'terminal'`,
  `CREATE INDEX IF NOT EXISTS idx_action_wave
     ON action(session_id, json_extract(intent, '$.waveId'), ordinal)`,
  `CREATE TABLE IF NOT EXISTS decision_fact (
    key TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    row_hash TEXT NOT NULL,
    time_created INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS armed_alarms (
    alarm_id TEXT PRIMARY KEY,
    occurrence_id TEXT NOT NULL UNIQUE,
    fire_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tool_outputs (
    output_id TEXT PRIMARY KEY,
    bytes BLOB NOT NULL,
    media_type TEXT
  )`,
];


const pageSize = z.number().int().positive().max(256);
const windowCount = z.number().int().nonnegative();
const OrdinalRow = z.object({ ordinal: z.number().int().positive() }).nullable();
type Reads = Pick<
  Storage.ActionSubAdapter,
  | "priorModelAttempt"
  | "generationFor"
  | "turnTerminalFor"
  | "latestTurnTerminal"
  | "latestTurnUpdate"
  | "turnIntentsPage"
  | "turnWindowStart"
  | "turnTailPage"
  | "openTurnsPage"
  | "resultFor"
  | "requestInputById"
  | "requestStateById"
  | "guardedOperationsPage"
  | "requestStatesPage"
  | "outboundStatesPage"
  | "openOperationsPage"
  | "operationChildrenPage"
  | "pendingMessages"
  | "latestCompaction"
  | "inputMessages"
>;

/**
 * Read degradation (#1252): a row that fails decode is kept verbatim on disk,
 * emits one `journal.corrupt{seq, kind, reason}` observation and folds as
 * opaque — its stored intent/effect text carried as plain string values. A row
 * that cannot even shape an opaque node is skipped; one bad row never blocks
 * session load.
 */
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
 * Projection reads degrade by exclusion (#1252): a corrupt row emits the same
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
function createActionReads(db: Database, sink: ObservationSink): Reads {
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
          .query<ActionSqlRow, [string, string, number]>(`
        SELECT a.* FROM action a WHERE a.session_id = ? AND a.kind = 'message'
          AND json_extract(a.intent, '$.op') IN ('open', 'ack')
          AND coalesce(json_extract(a.effect, '$.outbound.message.messageId'), a.id) > ?
          AND (json_extract(a.effect, '$.outbound.message.messageId') IS NULL
            OR a.ordinal = (SELECT max(b.ordinal) FROM action b WHERE b.session_id = a.session_id
              AND b.kind = 'message' AND json_extract(b.effect, '$.outbound.message.messageId') =
                json_extract(a.effect, '$.outbound.message.messageId')))
        ORDER BY coalesce(json_extract(a.effect, '$.outbound.message.messageId'), a.id) LIMIT ?`)
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
          .query<ActionSqlRow, [string]>(`
        SELECT a.* FROM action a WHERE a.session_id = ? AND a.kind IN ('prompt', 'signal', 'action')
          AND COALESCE(json_extract(a.effect, '$.deliveryKind'), json_extract(a.effect, ${legacyKindPath})) IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM action d WHERE d.session_id = a.session_id
            AND d.kind IN ('prompt', 'signal', 'action')
            AND COALESCE(json_extract(d.intent, '$.deliveryId'), json_extract(d.intent, ${legacyIdPath})) = a.id)
          AND NOT EXISTS (SELECT 1 FROM action t, json_each(t.intent, '$.consumedStale') stale
            WHERE t.session_id = a.session_id AND t.kind = 'turn' AND json_valid(t.intent)
            AND stale.value = a.id)
        ORDER BY a.ordinal`)
          .all(sessionId),
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
    // #1257: the SQL replacement for the retired received-message TS re-fold.
    inputMessages(sessionId) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string]>(`
        SELECT a.* FROM action a WHERE a.session_id = ? AND a.kind IN ('prompt', 'signal', 'action')
          AND COALESCE(json_extract(a.effect, '$.deliveryKind'), json_extract(a.effect, ${legacyKindPath})) IS NOT NULL
        ORDER BY a.ordinal`)
          .all(sessionId),
      );
    },
  };
}


export function createActions(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
  onObservationFailure: ObservationFailurePort,
): ProtocolStorage.ActionSubAdapter {
  return {
    ...createActionReads(db, observationSink),
    append(input, expectedRevision) {
      const parsed = LedgerAction.Append.parse(input);
      const receipt = transaction(() => appendAction(db, parsed, expectedRevision));
      if (receipt !== undefined) reportCommitted(db, observationSink, onObservationFailure, receipt);
      return receipt;
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
      const row = z
        .object({ intent: z.string() })
        .nullable()
        .parse(
          db
            .query(
              `SELECT intent FROM action WHERE session_id = ? AND kind = 'policy.decision'
           AND json_extract(intent, '$.inputHash') = ? ORDER BY ordinal DESC LIMIT 1`,
            )
            .get(sessionId, inputHash),
        );
      if (row === null) return undefined;
      const parsed = z
        .object({ matchedRuleIds: z.array(z.string()) })
        .safeParse(parsePlainJson(row.intent));
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
    verifyChain(sessionId) {
      return verifyChain(db, sessionId);
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
        const action = decodeActionDegraded(row, observationSink);
        return action === undefined ? [] : [action];
      });
    },
  };
}

// ─── #1254 S3: durable armed-alarm index reads ───

/**
 * One armed occurrence restored from the `armed_alarms` index (#1254 S3).
 * `purpose`/`sourceKey`/`payload` are re-read from the committed `arm` row by
 * `occurrenceId`; `armSeq` is recovered from the arm row id
 * `${alarmId}:arm:${armSeq}` (decision: not stored in the table — the row id
 * already carries it losslessly).
 */
export interface ArmedAlarmRow {
  readonly alarmId: string;
  readonly occurrenceId: string;
  readonly fireAt: number;
  readonly purpose: string;
  readonly armSeq: number;
  readonly sourceKey: string;
  /** Canonical JSON of the arm's payload. */
  readonly payload: string;
}

const ArmedAlarmSqlRow = z.object({
  alarm_id: z.string(),
  occurrence_id: z.string(),
  fire_at: z.number(),
  arm_id: z.string(),
  intent: z.string(),
});

const ArmIntentView = z.object({
  purpose: z.string().min(1),
  sourceKey: z.string().min(1),
  payload: PlainObjectSchema.optional(),
});

const ArmedCountRow = z.object({ count: z.number().int().nonnegative() });

function armSeqFromArmRowId(armRowId: string): number {
  const marker = armRowId.lastIndexOf(":arm:");
  const seq = marker < 0 ? Number.NaN : Number(armRowId.slice(marker + ":arm:".length));
  if (!Number.isInteger(seq) || seq < 0)
    throw new LedgerInvariant({
      operation: "alarm.armedAlarms",
      message: `arm row id does not carry an armSeq: ${armRowId}`,
    });
  return seq;
}

/** Read ports over the `armed_alarms` index; the index itself is written only inside the append transaction. */
function createArmedAlarmReads(db: Database): {
  armedAlarms(): readonly ArmedAlarmRow[];
  armedCount(): number;
} {
  return {
    armedAlarms() {
      const rows = ArmedAlarmSqlRow.array().parse(
        db
          .query(`
        SELECT aa.alarm_id, aa.occurrence_id, aa.fire_at, a.id AS arm_id, a.intent AS intent
        FROM armed_alarms aa
        JOIN action a ON a.kind = 'alarm'
          AND json_extract(a.intent, '$.op') = 'arm'
          AND json_extract(a.effect, '$.occurrenceId') = aa.occurrence_id
        ORDER BY aa.fire_at, aa.alarm_id`)
          .all(),
      );
      return rows.map((row): ArmedAlarmRow => {
        const intent = ArmIntentView.parse(parsePlainJson(row.intent));
        return {
          alarmId: row.alarm_id,
          occurrenceId: row.occurrence_id,
          fireAt: row.fire_at,
          purpose: intent.purpose,
          armSeq: armSeqFromArmRowId(row.arm_id),
          sourceKey: intent.sourceKey,
          payload: canonicalJson(intent.payload ?? {}),
        };
      });
    },
    armedCount() {
      return ArmedCountRow.parse(
        db.query("SELECT COUNT(*) AS count FROM armed_alarms").get(),
      ).count;
    },
  };
}

// ─── #1305 bounded tool output projection: content-addressed output bytes ───

/** One stored tool output write: digest-named bytes plus an optional media hint. */
export interface ToolOutputWrite {
  /** `canonicalDigest` identity of the bytes: `sha256:<64 hex>`. */
  readonly outputId: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

/** One stored tool output read back by its identifier. */
export interface ToolOutputRow {
  readonly outputId: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

const ToolOutputSqlRow = z.object({
  output_id: z.string(),
  bytes: z.instanceof(Uint8Array),
  media_type: z.string().nullable(),
});

/**
 * Content-addressed tool output storage (#1305): `put` is idempotent — the
 * digest key makes a repeated store of identical bytes a no-op, so a retried
 * tool settlement never duplicates bytes. Writes run in their own implicit
 * transaction BEFORE the referencing row commits: a crash between the two
 * leaves an unreferenced output (harmless), never a dangling reference.
 */
export interface ToolOutputsAdapter {
  put(write: ToolOutputWrite): void;
  get(outputId: string): ToolOutputRow | undefined;
}

function createToolOutputs(db: Database): ToolOutputsAdapter {
  return {
    put(write) {
      db.query("INSERT OR IGNORE INTO tool_outputs (output_id, bytes, media_type) VALUES (?, ?, ?)")
        .run(write.outputId, write.bytes, write.mediaType ?? null);
    },
    get(outputId) {
      const row = ToolOutputSqlRow.nullable().parse(
        db.query("SELECT output_id, bytes, media_type FROM tool_outputs WHERE output_id = ?").get(outputId),
      );
      if (row === null) return undefined;
      return {
        outputId: row.output_id,
        bytes: row.bytes,
        ...(row.media_type === null ? {} : { mediaType: row.media_type }),
      };
    },
  };
}

/** Any stored representation SQLite admits into a TEXT hash column; only a string can verify. */
const HashCell = z.union([z.string(), z.null(), z.number(), z.bigint(), z.instanceof(Uint8Array)]);

function describeHashCell(cell: z.infer<typeof HashCell>): string {
  if (cell instanceof Uint8Array) return `blob:${Buffer.from(cell).toString("hex")}`;
  return String(cell);
}

const VerifyRow = ActionSqlRowSafeIntegers.extend({ prev_hash: HashCell, action_hash: HashCell });

function verifyChain(db: Database, sessionId: string): LedgerAction.ChainVerdict {
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


/**
 * Session-file schemaVersion (#1257): stamped into `PRAGMA user_version` when
 * this build opens the file. There is no migration plane — a session file is
 * either on this schema (and carries this marker after its first open by this
 * build) or it is a legacy file this code never reads; `Session.fork` refuses
 * a parent whose marker differs without touching the file.
 */
export const SESSION_FILE_SCHEMA_VERSION = 1;

const SessionUserVersion = z.object({ user_version: z.number().int().nonnegative() });

/**
 * Read-only schemaVersion probe (#1257): opens the file `readonly` and reads
 * only `PRAGMA user_version`, so a legacy parent file is never modified (and
 * its tables are never read). A missing file probes as 0 — not this schema.
 */
export function readSessionFileSchemaVersion(path: string): number {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    return SessionUserVersion.parse(db.query("PRAGMA user_version").get()).user_version;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

// busy_timeout comes FIRST: the pragma is connection-local (it never touches
// the database file), so applying it before any file-touching statement makes
// a concurrent multi-process open wait for a busy writer instead of failing
// its first read/write instantly with SQLITE_BUSY (W5.2 review F9).
const OPEN_PRAGMAS = [
  "PRAGMA busy_timeout = 5000",
  "PRAGMA journal_mode = WAL",
  // Decision-class writes survive power loss (#510 D1): committed appends are
  // durable, which is what "no record, no action" means.
  "PRAGMA synchronous = FULL",
  "PRAGMA foreign_keys = ON",
] as const;

export const SILENT_OBSERVATION_SINK: ObservationSink = { publish: () => undefined };

/** Applies the busy-first open pragmas, then bootstraps the fresh schema in
 * one immediate transaction so concurrent openers serialize on the DDL. */
export function bootstrapStoreDatabase(db: Database, schema: readonly string[]): void {
  for (const pragma of OPEN_PRAGMAS) {
    const statement = db.prepare(pragma);
    try {
      statement.all();
    } finally {
      statement.finalize();
    }
  }
  db.transaction(() => {
    for (const statement of schema) db.run(statement);
  }).immediate();
}

function openStoreDatabase(path: string, schema: readonly string[]): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  let bootstrapped = false;
  try {
    bootstrapStoreDatabase(db, schema);
    bootstrapped = true;
  } finally {
    if (!bootstrapped) db.close();
  }
  return db;
}

/** Folds the WAL back into the main file so a cold start reads a clean
 * baseline, then closes the connection. */
function closeStoreDatabase(db: Database): void {
  db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  db.close();
}

/** Shared transaction and idempotent close behavior for catalog and session files. */
export class StoreHandle {
  readonly observationSink: ObservationSink;
  /** The injected wall clock this handle was opened with; every timestamp the handle writes comes from it. */
  readonly now: () => number;
  // Every transaction caller is a write unit: take the write lock up front
  // (BEGIN IMMEDIATE) instead of upgrading mid-transaction.
  readonly transaction = <T>(operation: () => T): T => this.db.transaction(operation).immediate();
  protected readonly db: Database;
  private closed = false;

  constructor(db: Database, observationSink: ObservationSink, now: () => number) {
    this.db = db;
    this.observationSink = observationSink;
    this.now = now;
  }

  /** Idempotent — explicit teardown and scope finalizers may both close. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeStoreDatabase(this.db);
  }
}

/**
 * Handle-scoped per-session ledger file (W5.2 review F1): one open handle per
 * `<sessionsDir>/<sessionId>.sqlite`, no process-global registration. Owns the
 * session row, the action hash chain and decision facts of exactly one session.
 */
export class SessionStore extends StoreHandle {
  readonly sessions: SessionWriteAdapter;
  readonly actions: ProtocolStorage.ActionSubAdapter;
  readonly decisionFacts: ProtocolStorage.DecisionFactSubAdapter;
  /** #1254 S3: the durable armed-alarm index of this session file. */
  readonly armedAlarms: () => readonly ArmedAlarmRow[];
  readonly armedCount: () => number;
  /** #1305: content-addressed tool output bytes of this session file. */
  readonly toolOutputs: ToolOutputsAdapter;
  constructor(
    db: Database,
    observationSink: ObservationSink,
    now: () => number,
    onObservationFailure: ObservationFailurePort,
  ) {
    super(db, observationSink, now);
    this.sessions = createSessions(db, this.transaction, observationSink, onObservationFailure);
    this.actions = createActions(db, this.transaction, observationSink, onObservationFailure);
    this.decisionFacts = createSqliteDecisionFacts(db);
    const armed = createArmedAlarmReads(db);
    this.armedAlarms = () => armed.armedAlarms();
    this.armedCount = () => armed.armedCount();
    this.toolOutputs = createToolOutputs(db);
  }

  /**
   * One atomic fork write (#1257): the child genesis materialization plus the
   * copied, rehashed pre-anchor rows land in a single transaction — a crashed
   * fork leaves either a complete child chain or no child session row at all
   * (session-file recovery needs no partial-fork repair path).
   */
  fork(input: SessionForkWrite): Effect.Effect<SessionForkReceipt, LedgerError> {
    return writeEffect("session.fork", (refuse: RefuseWrite) =>
      this.transaction(() => {
        const materialize = LedgerSession.Materialize.parse(input.materialize);
        const created = materializeSession(this.db, materialize, refuse);
        if (!created.created)
          return refuse(new MaterializeRefused({ sessionId: materialize.row.id, reason: "state" }));
        let receipt = created.receipt;
        for (const copy of input.copies) {
          const appended = appendAction(this.db, LedgerAction.Append.parse(copy), receipt.revision, refuse);
          if (appended === undefined)
            return refuse(new CorruptRecord({ operation: "session.fork", id: copy.id }));
          receipt = appended;
        }
        // #1305: outputs referenced by copied rows land in the same atomic
        // write, so a forked child never carries a dangling outputRef.
        for (const output of input.outputs ?? []) this.toolOutputs.put(output);
        const row = selectSession(this.db, materialize.row.id);
        if (row === undefined)
          return refuse(new CorruptRecord({ operation: "session.fork", id: materialize.row.id }));
        return { row, head: receipt.action.actionHash, copied: input.copies.length };
      }),
    );
  }
}

/** The atomic child write `Session.fork` hands the child store (#1257). */
interface SessionForkWrite {
  readonly materialize: LedgerSession.Materialize;
  /** Eligible pre-anchor parent rows, already remapped for the child chain. */
  readonly copies: readonly LedgerAction.Append[];
  /** #1305: stored outputs the copied rows reference, copied under the same identifiers. */
  readonly outputs?: readonly ToolOutputWrite[];
}

export interface SessionForkReceipt {
  readonly row: LedgerSession.Row;
  /** The child chain head hash after genesis plus every copy. */
  readonly head: string;
  readonly copied: number;
}

/**
 * The default failure port is an explicit drop: with the default silent sink a
 * publish cannot fail, and a host that injects an observing sink is expected
 * to inject its own port (logging in its runtime) alongside it.
 */
const DROP_OBSERVATION_FAILURES: ObservationFailurePort = () => undefined;

interface OpenSessionStoreOptions {
  /** Injected wall clock (#1245): the store never reads ambient time. */
  readonly now: () => number;
  readonly observationSink?: ObservationSink;
  readonly onObservationFailure?: ObservationFailurePort;
}

export function openSessionStore(path: string, options: OpenSessionStoreOptions): SessionStore {
  return new SessionStore(
    openStampedSessionDatabase(path),
    options.observationSink ?? SILENT_OBSERVATION_SINK,
    options.now,
    options.onObservationFailure ?? DROP_OBSERVATION_FAILURES,
  );
}

/** Opens the session file and stamps its schemaVersion marker (#1257). */
function openStampedSessionDatabase(path: string): Database {
  const db = openStoreDatabase(path, SESSION_FILE_SCHEMA);
  const version = SessionUserVersion.parse(db.query("PRAGMA user_version").get()).user_version;
  if (version < SESSION_FILE_SCHEMA_VERSION)
    db.run(`PRAGMA user_version = ${SESSION_FILE_SCHEMA_VERSION}`);
  return db;
}

/** Narrow l0 write-kernel surface (W5.2 review F6): fenced chain commits plus
 * the hash identity needed to verify them, without deep package imports. */
export const L0Write = {
  commitSession,
  insertSession,
  selectSession,
  GENESIS_PREV_HASH,
  computeActionHash,
} as const;
