import { Database, SQLiteError } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ObservationSink, Storage as ProtocolStorage } from "@oni/protocol";
import { z } from "zod";
import { LedgerSession } from "@oni/protocol";
import { CatalogUpgradeRefused, CatalogVersionRefused, SessionNotFound } from "./errors";
import { bootstrapStoreDatabase, SILENT_OBSERVATION_SINK, StoreHandle } from "./session-file/index.js";
import { createPolicies, createPolicyState } from "./storage/sqlite-l0-policies.js";

/**
 * The only catalog schema owner: the session index with its CAS-rotated fence
 * plus policy rows. Channel-facing tables are owned by `@oni/channels`
 * and attach to the same handle; the `cluster_*` tables are effect/cluster's.
 * There is no migration plane and the legacy `catalog.db` is never read.
 */
const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(", ");

/** The session-index role CHECK list: exactly the current role vocabulary. */
const ROLE_LIST = sqlList(LedgerSession.Role.options);

/**
 * Policy-row kinds are point kinds: the closed journal set plus the
 * one historical seed kind the point mapping still converts (gate/migrate.ts).
 */
const KIND_LIST = sqlList([
  "prompt", "signal", "turn", "llm", "message", "request", "alarm",
  "session.configure", "policy.decision", "tool", "compaction", "action",
  "fold.checkpoint", "ingress", "alarm.fired",
]);

const CATALOG_CORE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session_index (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    role TEXT NOT NULL CHECK (role IN (${ROLE_LIST})),
    fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
    created_at INTEGER NOT NULL,
    has_armed INTEGER NOT NULL DEFAULT 0 CHECK (has_armed IN (0, 1)),
    has_requests INTEGER NOT NULL DEFAULT 0 CHECK (has_requests IN (0, 1))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_session_index_parent ON session_index(parent_id, id)",
  `CREATE TABLE IF NOT EXISTS policy (
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (${KIND_LIST})),
    phase TEXT NOT NULL CHECK (phase IN ('pre', 'post')),
    match TEXT NOT NULL CHECK (json_valid(match)),
    verdict TEXT NOT NULL CHECK (json_valid(verdict)),
    encoding_version INTEGER NOT NULL CHECK (encoding_version = 1),
    priority INTEGER NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    PRIMARY KEY (generation, name, kind, phase)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_policy_read ON policy(generation, kind, phase, priority DESC, name)",
];
const POLICY_STATE_SCHEMA = `CREATE TABLE IF NOT EXISTS policy_state (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    value TEXT NOT NULL CHECK (json_valid(value)),
    PRIMARY KEY (namespace, key)
  )`;
export const CATALOG_SCHEMA: readonly string[] = [...CATALOG_CORE_SCHEMA, POLICY_STATE_SCHEMA];

/**
 * Catalog schemaVersion: stamped into `PRAGMA user_version` when the
 * catalog is created or opened by code at least this new. A file whose marker
 * is greater than this constant was written by newer code and opens read-only.
 */
const CATALOG_SCHEMA_VERSION = 6;

const UserVersion = z.object({ user_version: z.number().int().nonnegative() });

export interface SessionIndexRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: LedgerSession.Role;
  readonly fence: number;
  readonly createdAt: number;
  /** The session MAY hold armed alarms; the boot sweep rescans it. */
  readonly hasArmed: boolean;
}

export type SessionIndexInsert = Omit<SessionIndexRow, "fence" | "hasArmed"> & {
  /** True when the file already holds request rows (a fork copy, a repair re-index). */
  readonly hasRequests?: boolean;
};

const SessionIndexSqlRow = z
  .object({
    id: z.string(),
    parent_id: z.string().nullable(),
    role: LedgerSession.Role,
    fence: z.number().int().nonnegative(),
    created_at: z.number(),
    // A newer-code file opened read-only may shape this differently.
    has_armed: z.number().int().optional(),
  })
  .transform(
    (row): SessionIndexRow => ({
      id: row.id,
      parentId: row.parent_id,
      role: row.role,
      fence: row.fence,
      createdAt: row.created_at,
      hasArmed: (row.has_armed ?? 0) === 1,
    }),
  );

const RotatedFence = z.object({ fence: z.number().int().positive() });

/** Cross-session facts only; `commitSession`'s owner+fence check stays the write authority. */
export class CatalogStore extends StoreHandle {
  readonly policies: ProtocolStorage.PolicyRowSubAdapter;
  readonly policyState: ReturnType<typeof createPolicyState>;
  private readonly newerFileVersion: number | undefined;
  private readOnlyClosed = false;
  constructor(db: Database, observationSink: ObservationSink, now: () => number, newerFileVersion?: number) {
    super(db, observationSink, now);
    this.newerFileVersion = newerFileVersion;
    this.policies = createPolicies(db, this.transaction);
    this.policyState = createPolicyState(db);
  }

  /** The composition root attaches the channels-owned store here; the catalog builds none of it. */
  get database(): Database {
    return this.db;
  }

  /** A catalog written by newer code is read-only. */
  private refuseNewerSchema(
    operation: "indexSession" | "rotateFence" | "markArmed" | "markRequests",
  ): void {
    if (this.newerFileVersion === undefined) return;
    throw new CatalogVersionRefused({
      fileVersion: this.newerFileVersion,
      codeVersion: CATALOG_SCHEMA_VERSION,
      operation,
    });
  }

  /** A newer-schema catalog closes without the WAL checkpoint: zero writes. */
  override close(): void {
    if (this.newerFileVersion === undefined) {
      super.close();
      return;
    }
    if (this.readOnlyClosed) return;
    this.readOnlyClosed = true;
    this.db.close();
  }

  /** A lost race is not an error. */
  indexSession(input: SessionIndexInsert): boolean {
    this.refuseNewerSchema("indexSession");
    const inserted = this.db
      .query(
        `INSERT INTO session_index (id, parent_id, role, fence, created_at, has_requests)
         VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(input.id, input.parentId, input.role, input.createdAt, input.hasRequests === true ? 1 : 0);
    return inserted.changes === 1;
  }

  sessionIndex(id: string): SessionIndexRow | undefined {
    const row = SessionIndexSqlRow.nullable().parse(
      this.db.query("SELECT * FROM session_index WHERE id = ?").get(id),
    );
    return row === null ? undefined : row;
  }

  sessionIds(): string[] {
    return z.array(z.object({ id: z.string() })).parse(
      this.db.query("SELECT id FROM session_index ORDER BY id").all(),
    ).map((row) => row.id);
  }

  childSessionsPage(parentId: string, afterId: string, limit: number): SessionIndexRow[] {
    const size = z.number().int().positive().max(256).parse(limit);
    return z.array(SessionIndexSqlRow).parse(this.db.query(
      "SELECT * FROM session_index WHERE parent_id = ? AND id > ? ORDER BY id LIMIT ?",
    ).all(parentId, afterId, size));
  }

  /**
   * `has_armed = 1` is written BEFORE the arming commit and `= 0` only after a transaction
   * confirmed the index empty: an extra true costs a rescan, a premature false would lose recovery.
   */
  markArmed(sessionId: string, armed: boolean): void {
    this.refuseNewerSchema("markArmed");
    this.db
      .query("UPDATE session_index SET has_armed = ? WHERE id = ?")
      .run(armed ? 1 : 0, sessionId);
  }

  armedSessionIds(): readonly string[] {
    return z
      .array(z.object({ id: z.string() }))
      .parse(this.db.query("SELECT id FROM session_index WHERE has_armed = 1 ORDER BY id").all())
      .map((row) => row.id);
  }

  /**
   * `has_requests = 1` is written BEFORE the first commit carrying a request action and never
   * cleared: request scans skip only rows still at 0, so an extra true costs one session open.
   */
  markRequests(sessionId: string): void {
    this.refuseNewerSchema("markRequests");
    this.db
      .query("UPDATE session_index SET has_requests = 1 WHERE id = ? AND has_requests = 0")
      .run(sessionId);
  }

  /** Sessions the index knows hold no request; a file without an index row is never listed. */
  requestFreeSessionIds(): readonly string[] {
    return z
      .array(z.object({ id: z.string() }))
      .parse(this.db.query("SELECT id FROM session_index WHERE has_requests = 0 ORDER BY id").all())
      .map((row) => row.id);
  }

  /**
   * Only ALLOCATES the next fence: authority transfers when the winner adopts it into the session
   * file, whose lock serializes against every fenced commit.
   */
  rotateFence(sessionId: string): number {
    this.refuseNewerSchema("rotateFence");
    return this.transaction(() => {
      const rotated = RotatedFence.nullable().parse(
        this.db
          .query("UPDATE session_index SET fence = fence + 1 WHERE id = ? RETURNING fence")
          .get(sessionId),
      );
      if (rotated === null) throw new SessionNotFound({ sessionId });
      return rotated.fence;
    });
  }
}

interface OpenCatalogStoreOptions {
  /** Catalog adapters never read ambient time. */
  readonly now: () => number;
  readonly observationSink?: ObservationSink;
}

/**
 * SQLite cannot alter a CHECK constraint, so older catalogs rebuild both constrained tables.
 * The copy rewrites only the retired role and ingress bytes to the current vocabulary, including
 * role bytes in policy matches. Collisions and other invalid values fail the transaction.
 * Session-file journal bytes and hashes are untouched.
 */
function migrateCatalogChecks(db: Database): void {
  for (const table of ["session_index", "policy"] as const) {
    db.run(`ALTER TABLE ${table} RENAME TO ${table}_old`);
  }
  // The raw DDL list: pragmas cannot change inside the migration transaction.
  for (const statement of CATALOG_SCHEMA) db.run(statement);
  // Pre-v5 rows may hold requests the hint never saw: backfill true, the scan proves it.
  db.run(`INSERT INTO session_index (id, parent_id, role, fence, created_at, has_armed, has_requests)
    SELECT id, parent_id, CASE WHEN role = 'worker' THEN 'child' ELSE role END,
      fence, created_at, has_armed, 1 FROM session_index_old`);
  db.run(`INSERT INTO policy (name, kind, phase, match, verdict, encoding_version, priority, generation)
    SELECT name, CASE WHEN phase = 'pre' AND kind = 'inbox.deliver' THEN 'ingress' ELSE kind END,
      phase,
      CASE WHEN json_extract(match, '$.message.targetRole') = 'worker'
        THEN json_set(
          CASE WHEN json_extract(match, '$.message.senderRole') = 'worker'
            THEN json_set(CASE WHEN json_extract(match, '$.role') = 'worker'
              THEN json_set(match, '$.role', 'child') ELSE match END, '$.message.senderRole', 'child')
            ELSE CASE WHEN json_extract(match, '$.role') = 'worker'
              THEN json_set(match, '$.role', 'child') ELSE match END END,
          '$.message.targetRole', 'child')
        ELSE CASE WHEN json_extract(match, '$.message.senderRole') = 'worker'
          THEN json_set(CASE WHEN json_extract(match, '$.role') = 'worker'
            THEN json_set(match, '$.role', 'child') ELSE match END, '$.message.senderRole', 'child')
          ELSE CASE WHEN json_extract(match, '$.role') = 'worker'
            THEN json_set(match, '$.role', 'child') ELSE match END END END,
      verdict, encoding_version, priority, generation FROM policy_old`);
  db.run("DROP TABLE session_index_old");
  db.run("DROP TABLE policy_old");
  // RENAME carried the old tables' indexes with them and DROP removed them;
  // a second DDL pass recreates the indexes on the rebuilt tables.
  for (const statement of CATALOG_SCHEMA) db.run(statement);
}

export function openCatalogStore(path: string, options: OpenCatalogStoreOptions): CatalogStore {
  const sink = options.observationSink ?? SILENT_OBSERVATION_SINK;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  let handle: CatalogStore | undefined;
  try {
    const fileVersion = UserVersion.parse(db.query("PRAGMA user_version").get()).user_version;
    if (fileVersion > CATALOG_SCHEMA_VERSION) {
      // Newer-code file: no DDL, no file-touching pragma, no marker rewrite.
      db.run("PRAGMA busy_timeout = 5000");
      db.run("PRAGMA query_only = ON");
      handle = new CatalogStore(db, sink, options.now, fileVersion);
      return handle;
    }
    bootstrapStoreDatabase(db, fileVersion > 0 && fileVersion < CATALOG_SCHEMA_VERSION ? CATALOG_CORE_SCHEMA : CATALOG_SCHEMA);
    if (fileVersion > 0 && fileVersion < CATALOG_SCHEMA_VERSION) {
      try {
        db.transaction(() => {
          if (fileVersion === 1) {
            // v1 -> v2: the one guarded column add; fresh files get it from CATALOG_SCHEMA.
            db.run("ALTER TABLE session_index ADD COLUMN has_armed INTEGER NOT NULL DEFAULT 0");
          }
          // Rebuild older CHECK constraints and rewrite retired bytes during the copy.
          if (fileVersion < 5) migrateCatalogChecks(db);
          else db.run(POLICY_STATE_SCHEMA);
          db.run(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION}`);
        }).immediate();
      } catch (cause) {
        if (!(cause instanceof SQLiteError)) throw cause;
        throw new CatalogUpgradeRefused({ fileVersion, codeVersion: CATALOG_SCHEMA_VERSION, cause });
      }
    } else if (fileVersion < CATALOG_SCHEMA_VERSION) {
      db.run(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION}`);
    }
    handle = new CatalogStore(db, sink, options.now);
    return handle;
  } finally {
    if (handle === undefined) db.close();
  }
}
