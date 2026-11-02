import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ChannelStoreInvariant } from "./errors.js";

const CHANNEL_STORE_DDL: readonly string[] = [
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
  `CREATE TABLE IF NOT EXISTS surface_key (
    key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_surface_key_session ON surface_key(session_id)",
  `CREATE TABLE IF NOT EXISTS rule (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE,
    data TEXT NOT NULL,
    approved INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_rule_enabled ON rule(enabled)",
  `CREATE TABLE IF NOT EXISTS rule_ledger (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    inbound_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    time INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_rule_ledger_inbound_lookup ON rule_ledger(inbound_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_ledger_decision ON rule_ledger(inbound_id) WHERE decision != 'deduped'",
  "CREATE INDEX IF NOT EXISTS idx_rule_ledger_limit ON rule_ledger(rule_id, decision, time)",
  `CREATE TABLE IF NOT EXISTS rule_delivery (
    inbound_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS rule_group (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    data TEXT NOT NULL,
    closed_at INTEGER,
    matched INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS rule_group_close (
    group_id TEXT NOT NULL REFERENCES rule_group(id),
    inbound_id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (group_id, inbound_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_rule_group_close_inbound ON rule_group_close(inbound_id)",
];

const QueryOnlyRow = z.object({ query_only: z.number().int() });

export function applyChannelStoreSchema(db: Database): void {
  const tables = z.array(z.object({ name: z.string() })).parse(db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channel_store_schema', 'actor_identity')",
  ).all());
  if (tables.some((table) => table.name === "channel_store_schema")) {
    const stamp = z.object({ version: z.number().int() }).parse(db.query("SELECT version FROM channel_store_schema").get());
    if (stamp.version !== 2) throw new ChannelStoreInvariant({ operation: "open", message: "unsupported channel store schema" });
  } else if (tables.length > 0) {
    throw new ChannelStoreInvariant({ operation: "open", message: "unsupported channel store schema" });
  }
  const readOnly = QueryOnlyRow.parse(db.query("PRAGMA query_only").get()).query_only === 1;
  if (readOnly) return;
  db.transaction(() => {
    for (const statement of CHANNEL_STORE_DDL) db.run(statement);
    db.run("CREATE TABLE IF NOT EXISTS channel_store_schema (version INTEGER NOT NULL)");
    if (tables.length === 0) db.run("INSERT INTO channel_store_schema (version) VALUES (2)");
  }).immediate();
}
