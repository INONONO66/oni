import type { Database } from "bun:sqlite";
import { z } from "zod";

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
  `CREATE TABLE IF NOT EXISTS automation (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    approved INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_automation_enabled ON automation(enabled)",
  `CREATE TABLE IF NOT EXISTS automation_ledger (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    inbound_id TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    time INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_automation_ledger_inbound ON automation_ledger(inbound_id)",
  "CREATE INDEX IF NOT EXISTS idx_automation_ledger_limit ON automation_ledger(automation_id, decision, time)",
];

const QueryOnlyRow = z.object({ query_only: z.number().int() });

export function applyChannelStoreSchema(db: Database): void {
  const readOnly = QueryOnlyRow.parse(db.query("PRAGMA query_only").get()).query_only === 1;
  if (readOnly) return;
  db.transaction(() => {
    for (const statement of CHANNEL_STORE_DDL) db.run(statement);
  }).immediate();
}
