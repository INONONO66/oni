import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogVersionRefused } from "../../src/core/store/errors";
import { openSessionStore, SESSION_FILE_SCHEMA_VERSION } from "../../src/core/store/session-file";
import { testNow } from "./helpers/storage";

test("a fresh session file is stamped and reopens at v3", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-v3-"));
  const path = join(directory, "session.sqlite");
  try {
    openSessionStore(path, { now: testNow }).close();
    openSessionStore(path, { now: testNow }).close();
    using raw = new Database(path, { readonly: true });
    expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: SESSION_FILE_SCHEMA_VERSION });
    expect(raw.query("SELECT strikes FROM armed_alarms").all()).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

for (const version of [-1, 2, SESSION_FILE_SCHEMA_VERSION + 1]) {
  test(`a session file stamped ${version} is refused without modification`, () => {
    const directory = mkdtempSync(join(tmpdir(), "session-version-"));
    const path = join(directory, "session.sqlite");
    try {
      const raw = new Database(path);
      raw.run(`PRAGMA user_version = ${version}`);
      raw.close();
      const before = readFileSync(path);
      let refusal: CatalogVersionRefused | undefined;
      try {
        openSessionStore(path, { now: testNow });
      } catch (error) {
        if (error instanceof CatalogVersionRefused) refusal = error;
        else throw error;
      }
      expect(refusal).toMatchObject({
        _tag: "CatalogVersionRefused",
        fileVersion: version,
        codeVersion: SESSION_FILE_SCHEMA_VERSION,
        operation: "openSessionStore",
      });
      expect(readFileSync(path)).toEqual(before);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
}

test("a checkpointed WAL session file is refused without creating sidecars", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-wal-version-"));
  const path = join(directory, "session.sqlite");
  try {
    const raw = new Database(path);
    raw.run("PRAGMA journal_mode = WAL");
    raw.run("PRAGMA user_version = 2");
    raw.run("CREATE TABLE marker (id INTEGER)");
    raw.run("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    const before = readFileSync(path);

    expect(() => openSessionStore(path, { now: testNow })).toThrow(CatalogVersionRefused);
    expect(readdirSync(directory)).toEqual(["session.sqlite"]);
    expect(readFileSync(path)).toEqual(before);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
