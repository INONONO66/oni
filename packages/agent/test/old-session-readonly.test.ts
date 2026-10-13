import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogStore } from "../src/core/store/catalog";
import { CatalogVersionRefused } from "../src/core/store/errors";
import { testNow } from "./store/helpers/storage";

/**
 * Catalog schemaVersion: the catalog stamps `PRAGMA user_version` at create; a file whose marker is greater
 * than the code's version opens read-only — reads succeed, Deliver (fence rotation) and fork (session indexing)
 * are refused with the typed CatalogVersionRefused, and the file bytes are identical before and after the
 * read-only session.
 */

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("#1252 newer catalog schemaVersion: reads work, Deliver/fork refused typed, bytes unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-readonly-"));
  const path = join(dir, "catalog.sqlite");
  try {
    const created = openCatalogStore(path, { now: testNow });
    created.indexSession({ id: "s-1", parentId: null, role: "resident", createdAt: 1 });
    created.close();

    // The marker is stamped at create; bump it out of band past this build.
    const stamped = new Database(path);
    expect(stamped.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    stamped.run("PRAGMA user_version = 99");
    stamped.close();
    const before = fileHash(path);

    const reopened = openCatalogStore(path, { now: testNow });
    try {
      // Reads succeed against the newer file.
      expect(reopened.sessionIndex("s-1")).toEqual({
        id: "s-1",
        parentId: null,
        role: "resident",
        fence: 0,
        createdAt: 1,
        hasArmed: false,
      });
      expect(reopened.childSessionsPage("s-1", "", 10)).toEqual([]);

      // Fork (session indexing) is refused with the typed error.
      let indexRefusal: Error | undefined;
      try {
        reopened.indexSession({ id: "s-2", parentId: "s-1", role: "child", createdAt: 2 });
      } catch (error) {
        indexRefusal = error instanceof Error ? error : new Error(String(error));
      }
      expect(indexRefusal).toBeInstanceOf(CatalogVersionRefused);
      if (indexRefusal instanceof CatalogVersionRefused) {
        expect(indexRefusal.fileVersion).toBe(99);
        expect(indexRefusal.codeVersion).toBe(4);
        expect(indexRefusal.operation).toBe("indexSession");
        expect(indexRefusal.message).toBe(
          "catalog schemaVersion 99 is newer than this build (4); indexSession refused — catalog is read-only",
        );
      }

      // Deliver (activation fence rotation) is refused with the typed error.
      let fenceRefusal: Error | undefined;
      try {
        reopened.rotateFence("s-1");
      } catch (error) {
        fenceRefusal = error instanceof Error ? error : new Error(String(error));
      }
      expect(fenceRefusal).toBeInstanceOf(CatalogVersionRefused);
      if (fenceRefusal instanceof CatalogVersionRefused) {
        expect(fenceRefusal.fileVersion).toBe(99);
        expect(fenceRefusal.codeVersion).toBe(4);
        expect(fenceRefusal.operation).toBe("rotateFence");
      }
    } finally {
      reopened.close();
    }

    // The read-only session left the file byte-identical.
    expect(fileHash(path)).toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
