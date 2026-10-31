import { policySnapshot } from "../helpers/compiled-policy";
import { KERNEL_POLICY_REGISTRY } from "../../src/core/gate/compile";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCatalogStore } from "../../src/core/store/catalog";
import { CatalogUpgradeRefused } from "../../src/core/store/errors";
import { RETIRED_INGRESS_KIND, RETIRED_ROLE, rawCatalogRows, writeOldCatalog } from "./helpers/old-catalog";

const options = { now: () => 1 };

function withCatalog(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "catalog-upgrade-"));
  try {
    run(join(directory, "catalog.sqlite"));
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test("v3 message match role bytes upgrade on disk and compile for the pinned generation", () => {
  withCatalog((path) => {
    const legacyMatch = JSON.stringify({
      role: RETIRED_ROLE,
      message: {
        id: "message-rule", table: "B", sender: "session", senderRole: RETIRED_ROLE,
        targetRole: RETIRED_ROLE, effect: "allow", check: { kind: "type" },
      },
    });
    writeOldCatalog(path, {
      version: 3,
      roles: ["resident", "child", RETIRED_ROLE],
      kinds: ["compaction", "message"],
      sessions: [["old", null, RETIRED_ROLE]],
      policies: [
        ["compaction", "compaction", "pre", 1],
        ["message-rule", "message", "pre", 1, legacyMatch],
      ],
    });
    const store = openCatalogStore(path, options);
    try {
      const rows = store.policies.rows(1);
      expect(policySnapshot({ rows, generation: 1, registry: KERNEL_POLICY_REGISTRY }).generation).toBe(1);
      expect(rows.find((row) => row.name === "message-rule")?.match.value).toEqual({
        role: "child",
        message: {
          id: "message-rule", table: "B", sender: "session", senderRole: "child",
          targetRole: "child", effect: "allow", check: { kind: "type" },
        },
      });
    } finally {
      store.close();
    }
    const db = new Database(path, { readonly: true });
    try {
      expect(db.query("SELECT match FROM policy WHERE name = 'message-rule'").get()).toEqual({
        match: JSON.stringify({
          role: "child",
          message: {
            id: "message-rule", table: "B", sender: "session", senderRole: "child",
            targetRole: "child", effect: "allow", check: { kind: "type" },
          },
        }),
      });
      expect(db.query("SELECT match FROM policy WHERE name = 'compaction'").get()).toEqual({ match: "{}" });
    } finally {
      db.close();
    }
  });
});

test("v3 key collision refuses upgrade with a typed error and rolls back every row and schema marker", () => {
  withCatalog((path) => {
    writeOldCatalog(path, {
      version: 3,
      roles: ["resident", "child", RETIRED_ROLE],
      kinds: ["ingress", RETIRED_INGRESS_KIND],
      sessions: [["old", null, RETIRED_ROLE]],
      policies: [
        ["ingress-screen", RETIRED_INGRESS_KIND, "pre", 1],
        ["ingress-screen", "ingress", "pre", 1],
      ],
    });
    const before = rawCatalogRows(path);
    const db = new Database(path, { readonly: true });
    const fullBefore = {
      sessions: db.query("SELECT * FROM session_index ORDER BY id").all(),
      policies: db.query("SELECT * FROM policy ORDER BY generation, name, kind").all(),
      schema: db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
    };
    db.close();
    expect(() => openCatalogStore(path, options)).toThrow(expect.objectContaining({
      _tag: "CatalogUpgradeRefused", fileVersion: 3, codeVersion: 6,
    }));
    try {
      openCatalogStore(path, options).close();
      throw new Error("collision should refuse the catalog upgrade");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogUpgradeRefused);
      if (error instanceof CatalogUpgradeRefused) expect(error.cause.message).toContain("UNIQUE constraint failed");
    }
    expect(rawCatalogRows(path)).toEqual(before);
    const after = new Database(path, { readonly: true });
    try {
      expect({
        sessions: after.query("SELECT * FROM session_index ORDER BY id").all(),
        policies: after.query("SELECT * FROM policy ORDER BY generation, name, kind").all(),
        schema: after.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      }).toEqual(fullBefore);
      expect(after.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    } finally {
      after.close();
    }
  });
});

test("foreign v3 role and pre-kind bytes are rejected rather than silently normalized", () => {
  for (const invalid of ["role", "kind"] as const) {
    withCatalog((path) => {
      writeOldCatalog(path, {
        version: 3,
        roles: ["resident", "child", RETIRED_ROLE, "foreign"],
        kinds: ["ingress", RETIRED_INGRESS_KIND, "foreign"],
        sessions: [["old", null, invalid === "role" ? "foreign" : RETIRED_ROLE]],
        policies: [["ingress-screen", invalid === "kind" ? "foreign" : RETIRED_INGRESS_KIND, "pre", 1]],
      });
      const before = rawCatalogRows(path);
      expect(() => openCatalogStore(path, options)).toThrow(CatalogUpgradeRefused);
      expect(rawCatalogRows(path)).toEqual(before);
    });
  }
});
