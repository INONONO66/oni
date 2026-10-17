import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  LedgerAction,
  LedgerSession,
  type ObservationSink,
  type Storage as ProtocolStorage,
} from "@openomni/protocol";

import { z } from "zod";
import { CatalogVersionRefused, CorruptRecord, CreateRefused, MaterializeRefused, SessionFileUnreadable, type LedgerError } from "../errors";
import { computeActionHash, GENESIS_PREV_HASH } from "../action-hash.js";
import type { SessionWriteAdapter } from "../services";
import { createSqliteDecisionFacts } from "../decision.js";
import {
  type AppendLimits,
  appendAction,
  commitSession,
  DEFAULT_ROW_BYTE_CAP,
  insertSession,
  selectSession,
} from "../storage/sqlite-l0-write.js";
import { createSessions, materializeSession } from "../storage/sqlite-l0-sessions.js";
import { writeEffect, type RefuseWrite } from "../storage/write-effect.js";
import type { Effect } from "effect";
import { reportCommitted, type ObservationFailurePort } from "../storage/sqlite-l0-observation.js";


import { createActions } from "./actions";
import { createArmedAlarmPorts, type ArmedAlarmRow, type ArmedOccurrence } from "./alarms";
import { createToolOutputs, type ToolOutputWrite, type ToolOutputsAdapter } from "./outputs";

export { computeActionHash, GENESIS_PREV_HASH } from "../action-hash.js";

/** Fresh per-session ledger file DDL (W5.2 ) — the only session-file */
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
    fire_at INTEGER NOT NULL,
    strikes INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS tool_outputs (
    output_id TEXT PRIMARY KEY,
    bytes BLOB NOT NULL,
    media_type TEXT
  )`,
];


/**
 * Session-file schemaVersion () in `PRAGMA user_version`. v1 -> v2 is the one guarded upgrade
 * (`armed_alarms.strikes`, stamped in the same transaction); a newer-build file refuses to open (typed); fork refuses a differing marker.
 */
export const SESSION_FILE_SCHEMA_VERSION = 2;

const SessionUserVersion = z.object({ user_version: z.number().int().nonnegative() });

/** The `readonly` `PRAGMA user_version` read behind the probe; a missing file reads as 0. */
function probeSessionFileSchemaVersion(path: string): number {
  try {
    statSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw unreadableSessionFile(path, error instanceof Error ? error : new Error(String(error)));
  }
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    return SessionUserVersion.parse(db.query("PRAGMA user_version").get()).user_version;
  } catch (error) {
    throw unreadableSessionFile(path, error instanceof Error ? error : new Error(String(error)));
  } finally {
    db?.close();
  }
}

function unreadableSessionFile(path: string, error: Error): SessionFileUnreadable {
  return new SessionFileUnreadable({
    path,
    ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
    ...("errno" in error && typeof error.errno === "number" ? { errno: error.errno } : {}),
  });
}

/**
 * SchemaVersion probe before a fork: reads only `PRAGMA user_version` through a `readonly` open,
 * so an unstamped legacy parent (0) and a newer-build file are never modified nor their tables read.
 * An older stamped file (1 ≤ v < this schema) upgrades through the guarded path, then re-probes. Missing: 0.
 */
export function readSessionFileSchemaVersion(path: string): number {
  const version = probeSessionFileSchemaVersion(path);
  if (version === 0 || version >= SESSION_FILE_SCHEMA_VERSION) return version;
  closeStoreDatabase(openStampedSessionDatabase(path));
  return probeSessionFileSchemaVersion(path);
}

// busy_timeout comes FIRST: the pragma is connection-local (it never touches
// the database file), so applying it before any file-touching statement makes
// a concurrent multi-process open wait for a busy writer instead of failing
// its first read/write instantly with SQLITE_BUSY (W5.2 review F9).
const OPEN_PRAGMAS = [
  "PRAGMA busy_timeout = 5000",
  "PRAGMA journal_mode = WAL",
  // Decision-class writes survive power loss ( D1): committed appends are
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

/** Newer-build marker: typed `CatalogVersionRefused` before any DDL, stamp or read, no handle survives; else bootstrap and upgrade. */
function openStampedSessionDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const fresh = path !== ":memory:" && !existsSync(path);
  const db = new Database(path);
  let ready = false;
  try {
    const version = SessionUserVersion.parse(db.query("PRAGMA user_version").get()).user_version;
    if (version > SESSION_FILE_SCHEMA_VERSION) {
      throw new CatalogVersionRefused({
        fileVersion: version,
        codeVersion: SESSION_FILE_SCHEMA_VERSION,
        operation: "openSessionStore",
      });
    }
    bootstrapStoreDatabase(db, SESSION_FILE_SCHEMA);
    if (version < SESSION_FILE_SCHEMA_VERSION) upgradeSessionDatabase(db);
    ready = true;
  } finally {
    if (!ready) {
      db.close();
      if (fresh) rmSync(path, { force: true });
    }
  }
  return db;
}

const ColumnName = z.object({ name: z.string() });

/** The guarded column add and the stamp, one transaction. */
function upgradeSessionDatabase(db: Database): void {
  db.transaction(() => {
    const columns = ColumnName.array().parse(db.query("PRAGMA table_info(armed_alarms)").all());
    if (!columns.some((column) => column.name === "strikes"))
      db.run("ALTER TABLE armed_alarms ADD COLUMN strikes INTEGER NOT NULL DEFAULT 0");
    db.run(`PRAGMA user_version = ${SESSION_FILE_SCHEMA_VERSION}`);
  }).immediate();
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
  /**  S3: the durable armed-alarm index of this session file. */
  readonly armedAlarms: () => readonly ArmedAlarmRow[];
  /** The current occurrence of one alarm chain by primary key. */
  readonly armedAlarm: (alarmId: string) => ArmedOccurrence | undefined;
  readonly armedCount: () => number;
  readonly strikeArmedAlarm: (occurrenceId: string) => number | undefined;
  /** Moves one armed occurrence to `at` with strikes reset; false when the index lacks it. */
  readonly requeueArmedAlarm: (occurrenceId: string, at: number) => boolean;
  /** : content-addressed tool output bytes of this session file. */
  readonly toolOutputs: ToolOutputsAdapter;
  private readonly onObservationFailure: ObservationFailurePort;
  private readonly limits: AppendLimits;
  constructor(
    db: Database,
    observationSink: ObservationSink,
    now: () => number,
    onObservationFailure: ObservationFailurePort,
    limits: AppendLimits,
  ) {
    super(db, observationSink, now);
    this.onObservationFailure = onObservationFailure;
    this.limits = limits;
    this.sessions = createSessions(db, this.transaction, observationSink, onObservationFailure, limits);
    this.actions = createActions(db, this.transaction, observationSink, onObservationFailure, limits);
    this.decisionFacts = createSqliteDecisionFacts(db);
    const armed = createArmedAlarmPorts(db);
    this.armedAlarms = () => armed.armedAlarms();
    this.armedAlarm = (alarmId) => armed.armedAlarm(alarmId);
    this.armedCount = () => armed.armedCount();
    this.strikeArmedAlarm = (occurrenceId) => armed.strikeArmedAlarm(occurrenceId);
    this.requeueArmedAlarm = (occurrenceId, at) => armed.requeueArmedAlarm(occurrenceId, at);
    this.toolOutputs = createToolOutputs(db);
  }

  /**
   * One atomic fork write (): the child genesis materialization plus the
   * copied, rehashed pre-anchor rows land in a single transaction — a crashed
   * fork leaves either a complete child chain or no child session row at all
   * (session-file recovery needs no partial-fork repair path).
   */
  fork(input: SessionForkWrite): Effect.Effect<SessionForkReceipt, LedgerError> {
    const hasRequests = input.copies.some((copy) => copy.kind === "request");
    return writeEffect("session.fork", (refuse: RefuseWrite) =>
      this.indexed(input.index, input.materialize, input.createdAt, refuse, (materialize) => {
        const created = materializeSession(this.db, materialize, this.limits, refuse);
        if (!created.created)
          return refuse(new MaterializeRefused({ sessionId: materialize.row.id, reason: "state" }));
        let receipt = created.receipt;
        for (const copy of input.copies) {
          const appended = appendAction(
            this.db,
            LedgerAction.Append.parse(copy),
            receipt.revision,
            this.limits,
            refuse,
          );
          if (appended === undefined)
            return refuse(new CorruptRecord({ operation: "session.fork", id: copy.id }));
          receipt = appended;
        }
        // : outputs referenced by copied rows land in the same atomic
        // write, so a forked child never carries a dangling outputRef.
        for (const output of input.outputs ?? []) this.toolOutputs.put(output);
        const row = selectSession(this.db, materialize.row.id);
        if (row === undefined)
          return refuse(new CorruptRecord({ operation: "session.fork", id: materialize.row.id }));
        return { row, head: receipt.action.actionHash, copied: input.copies.length };
      }, hasRequests),
    );
  }

  /**
   * One creation write: the genesis row commits inside the catalog index transaction, so a duplicate on
   * either plane refuses typed with zero new facts, but the two files are not one atomic unit (see `indexed`).
   */
  create(input: SessionCreateWrite): Effect.Effect<SessionCreateReceipt, LedgerError> {
    return writeEffect("session.create", (refuse: RefuseWrite) => {
      const created = this.indexed(input.index, input.materialize, input.createdAt, refuse, (materialize) => {
        const result = materializeSession(this.db, materialize, this.limits, refuse);
        return result.created
          ? result
          : refuse(new CreateRefused({ sessionId: materialize.row.id, reason: "duplicate" }));
      });
      reportCommitted(this.db, this.observationSink, this.onObservationFailure, created.receipt);
      return { row: created.row, receipt: created.receipt };
    });
  }

  /**
   * The session file commits first, then the index row in its own unit; a refused or thrown index
   * deletes the uncommitted-to-catalog session again. `createdAt` is the caller's clock. A colliding
   * row is `duplicate` only with a file behind it; a catalog row alone is `orphan_index`.
   */
  private indexed<T>(
    index: SessionIndexUnit,
    input: LedgerSession.Materialize,
    createdAt: number,
    refuse: RefuseWrite,
    write: (materialize: LedgerSession.Materialize) => T,
    hasRequests = false,
  ): T {
    const materialize = LedgerSession.Materialize.parse(input);
    const { id, parentId, role } = materialize.row;
    const written = this.transaction(() => write(materialize));
    let indexed = false;
    try {
      indexed = index.transaction(() => index.indexSession({ id, parentId, role, createdAt, hasRequests }));
    } finally {
      if (!indexed)
        this.transaction(() => {
          this.db.query("DELETE FROM session WHERE id = ?").run(id);
          this.db.run("DELETE FROM tool_outputs");
        });
    }
    return indexed ? written : refuse(new CreateRefused({ sessionId: id, reason: "orphan_index" }));
  }
}

/** The catalog side of one creation: its write unit and index insert (`CatalogStore`, structurally). */
export interface SessionIndexUnit {
  readonly transaction: <T>(operation: () => T) => T;
  readonly indexSession: (input: {
    readonly id: string;
    readonly parentId: string | null;
    readonly role: LedgerSession.Role;
    readonly createdAt: number;
    readonly hasRequests?: boolean;
  }) => boolean;
}

/** The atomic genesis-plus-index write `createSession` hands the store. */
export interface SessionCreateWrite {
  readonly materialize: LedgerSession.Materialize;
  readonly index: SessionIndexUnit;
  /** The index row's creation stamp: the caller's clock (the genesis `at`). */
  readonly createdAt: number;
}

export interface SessionCreateReceipt {
  readonly row: LedgerSession.Row;
  readonly receipt: LedgerAction.Receipt;
}

/** The atomic child write `Session.fork` hands the child store (). */
interface SessionForkWrite {
  readonly materialize: LedgerSession.Materialize;
  /** The catalog unit the child's index row lands in, enclosing the child write. */
  readonly index: SessionIndexUnit;
  /** The child's index creation stamp: the fork's `now`. */
  readonly createdAt: number;
  /** Eligible pre-anchor parent rows, already remapped for the child chain. */
  readonly copies: readonly LedgerAction.Append[];
  /** : stored outputs the copied rows reference, copied under the same identifiers. */
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
  /** Injected wall clock (): the store never reads ambient time. */
  readonly now: () => number;
  readonly observationSink?: ObservationSink;
  readonly onObservationFailure?: ObservationFailurePort;
  /** Row payload cap at the append boundary; defaults to `DEFAULT_ROW_BYTE_CAP`. */
  readonly rowByteCap?: number;
}

export function openSessionStore(path: string, options: OpenSessionStoreOptions): SessionStore {
  return new SessionStore(
    openStampedSessionDatabase(path),
    options.observationSink ?? SILENT_OBSERVATION_SINK,
    options.now,
    options.onObservationFailure ?? DROP_OBSERVATION_FAILURES,
    { rowByteCap: options.rowByteCap ?? DEFAULT_ROW_BYTE_CAP },
  );
}

/** Narrow l0 write-kernel surface (W5.2 review F6): fenced chain commits plus
 * the hash identity needed to verify them, without deep package imports. */
export const L0Write = {
  commitSession,
  insertSession,
  selectSession,
  GENESIS_PREV_HASH,
  DEFAULT_ROW_BYTE_CAP,
  computeActionHash,
} as const;
