import { afterEach, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "@oni/agent";
import { openChannelStore, type ChannelStore } from "../../../src/store/sqlite/index.js";

/** Fixed injected clock (#1245): store tests assert exact timestamps. */
export const TEST_NOW = 1_700_000_000_000;
export const testNow = (): number => TEST_NOW;

export interface OpenedChannelStore {
  readonly db: Database;
  readonly store: ChannelStore;
  close(): void;
}

/**
 * The channels-owned store over one bootstrapped SQLite handle (#1317): the
 * same open pragmas production applies to the catalog file, then the
 * channel-store schema. Self-contained — no agent test fixture involved.
 */
export function openTestChannelStore(path: string): OpenedChannelStore {
  const db = new Database(path);
  Core.bootstrapStoreDatabase(db, []);
  return {
    db,
    store: openChannelStore(db, testNow),
    close: () => {
      db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
      db.close();
    },
  };
}

/** Fresh in-memory channel store per test. */
export function useMemoryChannelStore(): { readonly store: ChannelStore } {
  let opened: OpenedChannelStore | undefined;
  beforeEach(() => {
    opened = openTestChannelStore(":memory:");
  });
  afterEach(() => {
    opened?.close();
    opened = undefined;
  });
  const current = (): OpenedChannelStore => {
    if (opened === undefined) throw new Error("the channel store is only open inside a test");
    return opened;
  };
  return {
    get store() {
      return current().store;
    },
  };
}

/** One real on-disk channel store per test; `reopen` survives restarts. */
export function useSqliteChannelStore(label: string) {
  let directory = "";
  let dbPath = "";
  let opened: OpenedChannelStore | undefined;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), `${label}-`));
    dbPath = join(directory, "channel-store.sqlite");
    opened = openTestChannelStore(dbPath);
  });
  afterEach(() => {
    opened?.close();
    opened = undefined;
    rmSync(directory, { recursive: true });
  });
  const current = (): OpenedChannelStore => {
    if (opened === undefined) throw new Error("the channel store is only open inside a test");
    return opened;
  };
  return {
    get store() {
      return current().store;
    },
    get path() {
      return dbPath;
    },
    reopen() {
      current().close();
      opened = openTestChannelStore(dbPath);
    },
  };
}
