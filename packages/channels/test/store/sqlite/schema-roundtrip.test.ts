import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openChannelStore } from "../../../src/store/sqlite/index.js";
import { ChannelStoreInvariant } from "../../../src/store/sqlite/errors.js";
import { testNow } from "../helpers/sqlite";

const record = { id: "rule", position: 0, enabled: true, createdBy: "owner" as const,
  when: { instance: "chat" }, then: { target: "conversation", kind: "prompt" as const, reply: "auto" as const } };

function schema(db: Database) {
  return z.array(z.object({ name: z.string(), sql: z.string() })).parse(
    db.query("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all(),
  );
}

test("current channel stores reopen without changing schema or rule records", () => {
  const directory = mkdtempSync(join(tmpdir(), "rule-schema-"));
  try {
    const path = join(directory, "store.sqlite");
    const writer = new Database(path);
    const store = openChannelStore(writer, testNow);
    store.rule.set({ record, approved: true });
    store.actorRegistry.setIdentity({ id: "actor", kind: "human", trustTier: "owner" });
    const before = schema(writer);
    writer.close();
    using reader = new Database(path);
    const reopened = openChannelStore(reader, testNow);
    expect(schema(reader)).toEqual(before);
    expect(reopened.rule.get(record.id)).toEqual({ record, approved: true });
    expect(reopened.actorRegistry.getIdentity("actor")?.trustTier).toBe("owner");
    expect(reader.query("SELECT version FROM channel_store_schema").get()).toEqual({ version: 2 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each(["unstamped", "foreign"] as const)("a %s channel store is refused before DDL", (version) => {
  using db = new Database(":memory:");
  if (version === "unstamped") db.run("CREATE TABLE actor_identity (id TEXT)");
  else {
    db.run("CREATE TABLE channel_store_schema (version INTEGER NOT NULL)");
    db.run("INSERT INTO channel_store_schema VALUES (3)");
  }
  const before = schema(db);
  expect(() => openChannelStore(db, testNow)).toThrow(ChannelStoreInvariant);
  expect(schema(db)).toEqual(before);
});

test("query-only opening reads current rules without any schema writes", () => {
  using db = new Database(":memory:");
  openChannelStore(db, testNow).rule.set({ record, approved: true });
  const before = schema(db);
  db.run("PRAGMA query_only = ON");
  const reader = openChannelStore(db, testNow);
  expect(reader.rule.get(record.id)).toEqual({ record, approved: true });
  expect(schema(db)).toEqual(before);
  expect(() => reader.rule.remove(record.id)).toThrow(/readonly|read-only|query_only|attempt to write/i);
});
