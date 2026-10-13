import { Database } from "bun:sqlite";

// The two historical on-disk bytes the catalog v4 upgrade (#1351) rewrites.
// Spelled here as fixture data only: no source file names them any more.
export const RETIRED_ROLE = "worker";
export const RETIRED_INGRESS_KIND = "inbox.deliver";

export interface OldCatalogFixture {
  readonly version: 1 | 2 | 3;
  readonly roles: readonly string[];
  readonly kinds: readonly string[];
  readonly sessions: ReadonlyArray<readonly [id: string, parentId: string | null, role: string]>;
  readonly policies: ReadonlyArray<readonly [name: string, kind: string, phase: string, generation: number]>;
}

/** Writes a catalog file exactly as the named older DDL generation persisted it. */
export function writeOldCatalog(path: string, fixture: OldCatalogFixture): void {
  const db = new Database(path);
  const quote = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
  db.run(`CREATE TABLE session_index (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    role TEXT NOT NULL CHECK (role IN (${quote(fixture.roles)})),
    fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
    created_at INTEGER NOT NULL${fixture.version === 1 ? "" : ",\n    has_armed INTEGER NOT NULL DEFAULT 0 CHECK (has_armed IN (0, 1))"}
  )`);
  if (fixture.version > 1) {
    db.run(`CREATE TABLE policy (
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (${quote(fixture.kinds)})),
      phase TEXT NOT NULL CHECK (phase IN ('pre', 'post')),
      match TEXT NOT NULL CHECK (json_valid(match)),
      verdict TEXT NOT NULL CHECK (json_valid(verdict)),
      encoding_version INTEGER NOT NULL CHECK (encoding_version = 1),
      priority INTEGER NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      PRIMARY KEY (generation, name, kind, phase)
    )`);
  }
  for (const [index, [id, parentId, role]] of fixture.sessions.entries()) {
    db.run("INSERT INTO session_index (id, parent_id, role, fence, created_at) VALUES (?, ?, ?, ?, ?)", [
      id,
      parentId,
      role,
      index + 2,
      index + 5,
    ]);
  }
  for (const [name, kind, phase, generation] of fixture.policies) {
    db.run(
      `INSERT INTO policy (name, kind, phase, match, verdict, encoding_version, priority, generation)
       VALUES (?, ?, ?, '{}', '{"type":"allow"}', 1, 0, ?)`,
      [name, kind, phase, generation],
    );
  }
  db.run(`PRAGMA user_version = ${fixture.version}`);
  db.close();
}

/** The persisted catalog bytes that matter to the upgrade, read on a fresh read-only connection. */
export function rawCatalogRows(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return {
      version: db.query("PRAGMA user_version").get(),
      sessions: db.query("SELECT id, parent_id, role, fence, created_at FROM session_index ORDER BY id").all(),
      policies: db.query("SELECT name, kind, phase, generation FROM policy ORDER BY generation, name").all(),
    };
  } finally {
    db.close();
  }
}
