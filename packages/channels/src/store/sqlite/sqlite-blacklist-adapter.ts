import type { Database } from "bun:sqlite";
import { Actor, type Storage as ProtocolStorage } from "@oni/protocol";
import { sqliteJsonData } from "./json";

const BlacklistRow = sqliteJsonData(Actor.BlacklistEntry);

export function createSqliteBlacklistAdapter(
  db: Database,
  now: () => number,
): ProtocolStorage.BlacklistSubAdapter {
  return {
    get(id) {
      const row = BlacklistRow.nullable().parse(
        db.query("SELECT data FROM blacklist WHERE id = ?").get(id),
      );
      return row ?? undefined;
    },
    set(entry) {
      const at = now();
      db.query(
        `INSERT INTO blacklist (
           id, data, kind, value, expires_at, time_created, time_updated
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data = excluded.data,
           kind = excluded.kind,
           value = excluded.value,
           expires_at = excluded.expires_at,
           time_updated = excluded.time_updated`,
      ).run(
        entry.id,
        JSON.stringify(entry),
        entry.kind,
        entry.value,
        entry.expiresAt ?? null,
        entry.createdAt ?? at,
        entry.updatedAt ?? at,
      );
    },
    list() {
      return BlacklistRow.array().parse(
        db.query("SELECT data FROM blacklist ORDER BY time_created ASC, id ASC").all(),
      );
    },
    remove(id) {
      return db.query("DELETE FROM blacklist WHERE id = ?").run(id).changes > 0;
    },
  };
}
