import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ObservationSink, Storage as ProtocolStorage } from "@openomni/protocol";
import { z } from "zod";
import { LedgerSession } from "@openomni/protocol";
import { CatalogVersionRefused, SessionNotFound } from "./errors";
import { bootstrapStoreDatabase, SILENT_OBSERVATION_SINK, StoreHandle } from "./session-file/index.js";
import { createPolicies } from "./storage/sqlite-l0-policies.js";
import { LEGACY_INGRESS_POLICY_KIND } from "../gate/migrate.js";

/**
 * The only catalog schema owner: the session index with its CAS-rotated fence
 * plus policy rows. Channel-facing tables are owned by `@openomni/channels`
 * and attach to the same handle; the `cluster_*` tables are effect/cluster's.
 * There is no migration plane and the legacy `catalog.db` is never read.
 */
export const CATALOG_SCHEMA: readonly string[] = [
  // The role CHECK admits the retired pre-rename byte: rebuilt v2 files keep
  // their rows byte-for-byte and readers fold the legacy byte to `child`.
  `CREATE TABLE IF NOT EXISTS session_index (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('resident', 'child', '${LedgerSession.LEGACY_CHILD_ROLE}')),
    fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
    created_at INTEGER NOT NULL,
    has_armed INTEGER NOT NULL DEFAULT 0 CHECK (has_armed IN (0, 1))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_session_index_parent ON session_index(parent_id, id)",
  `CREATE TABLE IF NOT EXISTS policy (
    name TEXT NOT NULL,
    -- Policy-row kinds are point kinds (#1251): the closed journal set plus
    -- the two historical tokens the legacy point mapping still converts
    -- (gate/migrate.ts). Old catalog files keep their original CREATE TABLE
    -- (IF NOT EXISTS), so historical rows stay byte-for-byte.
    kind TEXT NOT NULL CHECK (kind IN (
      'prompt', 'signal', 'turn', 'llm', 'message', 'request', 'alarm',
      'session.configure', 'policy.decision', 'tool', 'compaction', 'action',
      'fold.checkpoint', 'ingress', '${LEGACY_INGRESS_POLICY_KIND}', 'alarm.fired'
    )),
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

/** A file whose `PRAGMA user_version` is greater than this was written by newer code and opens read-only. */
const CATALOG_SCHEMA_VERSION = 3;

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

export type SessionIndexInsert = Omit<SessionIndexRow, "fence" | "hasArmed">;

const SessionIndexSqlRow = z
  .object({
    id: z.string(),
    parent_id: z.string().nullable(),
    // Pre-rename files persist the retired role byte.
    role: z.string().transform((role) => LedgerSession.foldLegacyRole(role)).pipe(LedgerSession.Role),
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

/** Cross-session facts only; never authorizes a session-file write by itself — `commitSession`'s owner+fence check stays the authority. */
export class CatalogStore extends StoreHandle {
  readonly policies: ProtocolStorage.PolicyRowSubAdapter;
  private readonly newerFileVersion: number | undefined;
  private readOnlyClosed = false;
  constructor(db: Database, observationSink: ObservationSink, now: () => number, newerFileVersion?: number) {
    super(db, observationSink, now);
    this.newerFileVersion = newerFileVersion;
    this.policies = createPolicies(db, this.transaction);
  }

  /** The composition root attaches the channels-owned store to the same file; the catalog constructs nothing channel-facing. */
  get database(): Database {
    return this.db;
  }

  /** A catalog written by newer code is read-only. */
  private refuseNewerSchema(operation: "indexSession" | "rotateFence" | "markArmed"): void {
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
        `INSERT INTO session_index (id, parent_id, role, fence, created_at)
         VALUES (?, ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(input.id, input.parentId, input.role, input.createdAt);
    return inserted.changes === 1;
  }

  sessionIndex(id: string): SessionIndexRow | undefined {
    const row = SessionIndexSqlRow.nullable().parse(
      this.db.query("SELECT * FROM session_index WHERE id = ?").get(id),
    );
    return row === null ? undefined : row;
  }

  childSessionsPage(parentId: string, afterId: string, limit: number): SessionIndexRow[] {
    const size = z.number().int().positive().max(256).parse(limit);
    return z.array(SessionIndexSqlRow).parse(this.db.query(
      "SELECT * FROM session_index WHERE parent_id = ? AND id > ? ORDER BY id LIMIT ?",
    ).all(parentId, afterId, size));
  }

  /** `has_armed = 1` is written BEFORE the arming commit and `= 0` only after a transaction confirmed the index empty: an extra true costs a rescan, a premature false would lose recovery. */
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

  /** Only ALLOCATES the next fence: authority transfers when the winner adopts it into the session file, whose lock serializes against every fenced commit. */
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

/** SQLite cannot alter a CHECK constraint, so the two constrained tables are renamed aside, recreated from CATALOG_SCHEMA and every row copied unchanged. */
function migrateCatalogChecks(db: Database): void {
  for (const table of ["session_index", "policy"] as const) {
    db.run(`ALTER TABLE ${table} RENAME TO ${table}_v2`);
  }
  // The raw DDL list: pragmas cannot change inside the migration transaction.
  for (const statement of CATALOG_SCHEMA) db.run(statement);
  db.run(`INSERT INTO session_index (id, parent_id, role, fence, created_at, has_armed)
    SELECT id, parent_id, role, fence, created_at, has_armed FROM session_index_v2`);
  db.run(`INSERT INTO policy (name, kind, phase, match, verdict, encoding_version, priority, generation)
    SELECT name, kind, phase, match, verdict, encoding_version, priority, generation FROM policy_v2`);
  db.run("DROP TABLE session_index_v2");
  db.run("DROP TABLE policy_v2");
  // RENAME carried the old indexes away with the tables; recreate them.
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
    bootstrapStoreDatabase(db, CATALOG_SCHEMA);
    if (fileVersion > 0 && fileVersion < CATALOG_SCHEMA_VERSION) {
      db.transaction(() => {
        if (fileVersion === 1) {
          // v1 -> v2: the one guarded column add; fresh files get it from CATALOG_SCHEMA.
          db.run("ALTER TABLE session_index ADD COLUMN has_armed INTEGER NOT NULL DEFAULT 0");
        }
        // v2 -> v3: rebuild the CHECK constraints so `child` role rows and `ingress`
        // policy rows insert into pre-rename files; the retired byte stays on disk.
        migrateCatalogChecks(db);
        db.run(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION}`);
      }).immediate();
    } else if (fileVersion < CATALOG_SCHEMA_VERSION) {
      db.run(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION}`);
    }
    handle = new CatalogStore(db, sink, options.now);
    return handle;
  } finally {
    if (handle === undefined) db.close();
  }
}
