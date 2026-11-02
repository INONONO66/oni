import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createSurfaceKeyStore } from "../../../src/store/surface-key/index.js";
import { createSqliteSurfaceKeyAdapter } from "../../../src/store/sqlite/sqlite-surface-key-adapter.js";
import { useSqliteChannelStore } from "../helpers/sqlite";

describe("SurfaceKey SQLite persistence", () => {
  const stores = useSqliteChannelStore("surface-key");
  const surfaceKeys = () => createSurfaceKeyStore(stores.store);

  test("persists across Storage re-init", () => {
    surfaceKeys().claim("telegram:bot:chat:123", "persist-session");

    stores.reopen();

    expect(surfaceKeys().lookup("telegram:bot:chat:123")).toBe("persist-session");
  });

  test("re-claim with expected account updates session in SQLite", () => {
    surfaceKeys().claim("slack:ws:channel:C1", "old-session");
    surfaceKeys().claim("slack:ws:channel:C1", "new-session", "old-session");

    stores.reopen();

    expect(surfaceKeys().lookup("slack:ws:channel:C1")).toBe("new-session");
  });

  test("claim throws loudly when the row is missing after INSERT OR IGNORE", () => {
    // Impossible-state simulation: a trigger deletes every inserted row, so
    // the read-back inside claim's own transaction finds nothing. The old
    // `row?.session_id ?? sessionId` fallback silently fabricated custody
    // for exactly this unreachable state.
    const db = new Database(":memory:");
    db.exec(
      `CREATE TABLE surface_key (
         key TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         time_created INTEGER NOT NULL
       );
       CREATE TRIGGER surface_key_vanish AFTER INSERT ON surface_key
       BEGIN
         DELETE FROM surface_key WHERE key = NEW.key;
       END;`,
    );
    const adapter = createSqliteSurfaceKeyAdapter(db, () => 1_700_000_000_000);

    expect(() => adapter.claim("telegram:bot:chat:123", "ses-1")).toThrow(
      "surface_key row missing after INSERT OR IGNORE",
    );
    db.close();
  });
});
