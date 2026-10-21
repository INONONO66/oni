import type { Database } from "bun:sqlite";
import { Actor, type Storage as ProtocolStorage } from "@oni/protocol";
import { sqliteJsonData } from "./json";

const ChannelGrantRow = sqliteJsonData(Actor.ChannelGrant);

export function createSqliteChannelGrantAdapter(
  db: Database,
  now: () => number,
): ProtocolStorage.ChannelGrantSubAdapter {
  return {
    get(id) {
      const row = ChannelGrantRow.nullable().parse(
        db.query("SELECT data FROM channel_grant WHERE id = ?").get(id),
      );
      return row ?? undefined;
    },
    set(grant) {
      const at = now();
      db.query(
        `INSERT INTO channel_grant (
           id, data, surface, workspace, channel, kind, time_created, time_updated
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data = excluded.data,
           surface = excluded.surface,
           workspace = excluded.workspace,
           channel = excluded.channel,
           kind = excluded.kind,
           time_updated = excluded.time_updated`,
      ).run(
        grant.id,
        JSON.stringify(grant),
        grant.surface,
        grant.workspace ?? "",
        grant.channel ?? "",
        grant.kind,
        grant.createdAt ?? at,
        grant.updatedAt ?? at,
      );
    },
    list() {
      return ChannelGrantRow.array().parse(
        db.query("SELECT data FROM channel_grant ORDER BY time_created ASC, id ASC").all(),
      );
    },
    remove(id) {
      return db.query("DELETE FROM channel_grant WHERE id = ?").run(id).changes > 0;
    },
  };
}
