import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openChannelStore, type ChannelStore } from "../../../src/store/sqlite/index.js";
import { openTestChannelStore, testNow, TEST_NOW } from "../helpers/sqlite";

/**
 * Frozen copy of the channel-facing statements exactly as the pre-#1317 agent
 * catalog (c73bc03b3) declared them. This fixture must never track
 * `CHANNEL_STORE_DDL` — it IS the old bytes; the tests below prove the moved
 * schema produces an identical database, so a file written before the split
 * reads identically after it.
 */
const LEGACY_CATALOG_CHANNEL_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS actor_identity (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    kind TEXT NOT NULL,
    trust_tier TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_actor_identity_trust_tier ON actor_identity(trust_tier)",
  `CREATE TABLE IF NOT EXISTS actor_endpoint (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES actor_identity(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    channel TEXT NOT NULL,
    workspace TEXT NOT NULL,
    external_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_actor_endpoint_actor ON actor_endpoint(actor_id)",
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_actor_endpoint_lookup
     ON actor_endpoint(channel, workspace, external_id)`,
  `CREATE TABLE IF NOT EXISTS person (
    id TEXT PRIMARY KEY,
    trust_tier TEXT NOT NULL,
    data TEXT NOT NULL,
    revision INTEGER NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_person_trust_tier ON person(trust_tier)",
  `CREATE TABLE IF NOT EXISTS secret (
    id TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL,
    wrapped_dek BLOB NOT NULL,
    kek_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    rotated_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS channel_instance (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    data TEXT NOT NULL,
    revision INTEGER NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_channel_instance_provider ON channel_instance(provider)",
  `CREATE TABLE IF NOT EXISTS channel_grant (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    surface TEXT NOT NULL,
    workspace TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_channel_grant_kind ON channel_grant(kind)",
  `CREATE INDEX IF NOT EXISTS idx_channel_grant_lookup
     ON channel_grant(surface, workspace, channel)`,
  `CREATE TABLE IF NOT EXISTS reply_grant (
    id TEXT PRIMARY KEY NOT NULL,
    data TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    target_actor_id TEXT NOT NULL,
    surface_key TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE (rule_id, target_actor_id, surface_key)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_reply_grant_expiry ON reply_grant (expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_reply_grant_rule_expiry ON reply_grant (rule_id, expires_at)",
  `CREATE TABLE IF NOT EXISTS egress_debit (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    target_actor_id TEXT NOT NULL,
    class TEXT NOT NULL,
    at INTEGER NOT NULL,
    time_created INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_egress_debit_pair_at
     ON egress_debit(sender_id, target_actor_id, at)`,
  `CREATE TABLE IF NOT EXISTS blacklist (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON blacklist(expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_blacklist_kind_value ON blacklist(kind, value)",
  `CREATE TABLE IF NOT EXISTS surface_key (
    key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_surface_key_session ON surface_key(session_id)",
];

const CHANNEL_OBJECT_PREFIXES = [
  "actor_identity", "actor_endpoint", "person", "secret", "channel_instance",
  "channel_grant", "reply_grant", "egress_debit", "blacklist", "surface_key",
  "idx_actor", "idx_person", "idx_channel", "idx_reply_grant", "idx_egress",
  "idx_blacklist", "idx_surface_key",
];

/** Every channel-owned object in sqlite_master as `name => exact stored SQL`. */
function schemaBytes(db: Database): Map<string, string> {
  const rows = db
    .query("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
    .all() as { name: string; sql: string }[];
  return new Map(
    rows
      .filter((row) => CHANNEL_OBJECT_PREFIXES.some((p) => row.name.startsWith(p)))
      .map((row) => [row.name, row.sql]),
  );
}

/** One deterministic row in every one of the nine channel-facing tables. */
function seed(store: ChannelStore): void {
  store.actorRegistry.setIdentity({ id: "act_a", kind: "human", trustTier: "owner" });
  store.actorRegistry.setEndpoint({
    id: "ep_1", actorId: "act_a", channel: "discord", externalId: "u1",
    workspace: "guild", createdAt: 1, updatedAt: 1,
  });
  store.provisioning.setPerson({
    id: "person:alice", displayName: "alice", kind: "human", trustTier: "collaborator",
    endpoints: [{ channel: "telegram", externalId: "12345" }],
    revision: 0, createdBy: "test", updatedAt: TEST_NOW,
  });
  store.provisioning.setSecret({
    id: "secret:tg", ciphertext: new Uint8Array([1, 2, 3]), wrappedDek: new Uint8Array([4, 5]),
    kekId: "kek-1", purpose: "channel_credential", createdAt: TEST_NOW,
  });
  store.provisioning.setChannelInstance({
    id: "channel:telegram:main", provider: "telegram", identity: "bot", enabled: true,
    settings: { pollIntervalMs: 500 }, credentialRef: "secret:tg",
    revision: 0, createdBy: "test", updatedAt: TEST_NOW,
  });
  store.channelGrant.set({
    id: "grant-1", surface: "discord", workspace: "guild", channel: "design",
    kind: "broadcast_channel", defaultTier: "observer", inboundTreatment: "full_access",
    createdBy: "act_a", createdAt: 100, updatedAt: 200,
  });
  expect(
    store.egressBudget.claim(
      { id: "debit-1", senderId: "s", targetActorId: "t", class: "notify", at: TEST_NOW },
      TEST_NOW - 60_000,
      () => true,
    ),
  ).toBe("claimed");
  store.blacklist.set({
    id: "bl-1", kind: "actor", value: "act_bad", reason: "abuse",
    createdBy: "act_a", createdAt: 100, updatedAt: 200,
  });
  expect(store.surfaceKey.claim("telegram:bot:chat:1", "ses-1")).toBe("ses-1");
}

const TABLES = [
  "actor_identity", "actor_endpoint", "person", "secret", "channel_instance",
  "channel_grant", "egress_debit", "blacklist", "surface_key",
] as const;

/** What the replacer sees: a row column, a row, or the row array. */
type DumpValue = string | number | bigint | object | null;

/** Raw `SELECT *` dump per table: the durable bytes, below every adapter. */
function rowBytes(db: Database): Record<string, string> {
  const dump: Record<string, string> = {};
  for (const table of TABLES) {
    dump[table] = JSON.stringify(
      db.query(`SELECT * FROM ${table} ORDER BY 1`).all(),
      (_k, v: DumpValue) => (v instanceof Uint8Array ? Array.from(v) : v),
    );
  }
  return dump;
}

describe("#1317 schema round-trip: the moved store is byte-identical to the catalog's", () => {
  test("openChannelStore emits exactly the pre-split catalog DDL", () => {
    using legacy = new Database(":memory:");
    for (const statement of LEGACY_CATALOG_CHANNEL_DDL) legacy.run(statement);

    using moved = new Database(":memory:");
    openChannelStore(moved, testNow);

    const legacyBytes = schemaBytes(legacy);
    expect(legacyBytes.size).toBe(23);
    // #1569 retired the reply_grant projection (one table, two indexes); every
    // other object is still the catalog's exact bytes.
    for (const name of [...legacyBytes.keys()])
      if (name.includes("reply_grant")) legacyBytes.delete(name);
    expect(legacyBytes.size).toBe(20);
    expect(schemaBytes(moved)).toEqual(legacyBytes);
  });

  test("a pre-split catalog file reopens under the channel store with identical rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-roundtrip-"));
    const legacyPath = join(dir, "legacy.sqlite");
    const freshPath = join(dir, "fresh.sqlite");
    try {
      // A database laid out by the OLD owner's DDL, written through the store.
      {
        using db = new Database(legacyPath);
        for (const statement of LEGACY_CATALOG_CHANNEL_DDL) db.run(statement);
      }
      const legacy = openTestChannelStore(legacyPath);
      seed(legacy.store);
      legacy.close();

      // The same facts written into a database the NEW owner laid out itself.
      const fresh = openTestChannelStore(freshPath);
      seed(fresh.store);
      fresh.close();

      // Reopening the legacy file is a schema no-op and reads the same bytes.
      const reopened = openTestChannelStore(legacyPath);
      try {
        using freshDb = new Database(freshPath, { readonly: true });
        expect(rowBytes(reopened.db)).toEqual(rowBytes(freshDb));
        expect(reopened.store.actorRegistry.getIdentity("act_a")?.trustTier).toBe("owner");
        expect(reopened.store.surfaceKey.lookup("telegram:bot:chat:1")).toBe("ses-1");
        // #1569: the retired reply_grant table is dropped on reopen.
        expect(reopened.db.query("SELECT name FROM sqlite_master WHERE name = 'reply_grant'").all()).toEqual([]);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a query-only connection (newer-version fence, #1252) reads but never writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-readonly-"));
    const path = join(dir, "store.sqlite");
    try {
      const writer = openTestChannelStore(path);
      seed(writer.store);
      writer.close();

      using db = new Database(path);
      db.exec("PRAGMA query_only = ON");
      // Opening must not attempt DDL on the fenced connection.
      const store = openChannelStore(db, testNow);
      expect(store.actorRegistry.getIdentity("act_a")?.id).toBe("act_a");
      expect(store.blacklist.list()).toHaveLength(1);
      expect(() =>
        store.actorRegistry.setIdentity({ id: "act_b", kind: "human", trustTier: "observer" }),
      ).toThrow(/readonly|read-only|query_only|attempt to write/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
