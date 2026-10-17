import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionIndexInsert, SessionIndexRow } from "../../../src/core/store/catalog";
import { CATALOG_SCHEMA, openCatalogStore } from "../../../src/core/store/catalog";
import { SessionNotFound, StorageUnavailable } from "../../../src/core/store/errors";
import { testNow } from "../helpers/storage";
import { expectBusyBeforeSchema, policyFixture } from "./store-fixtures";

const PACKAGE_ROOT = resolve(import.meta.dir, "../../..");

test("ledger error contracts are runtime values", () => {
  expect(new SessionNotFound({ sessionId: "missing" })._tag).toBe("SessionNotFound");
  expect(new StorageUnavailable({ capability: "sessions" })._tag).toBe("StorageUnavailable");
});

test("openCatalogStore bootstraps a fresh catalog: exactly the two agent-owned tables (#1317)", () => {
  const directory = mkdtempSync(join(tmpdir(), "catalog-store-"));
  const path = join(directory, "catalog.sqlite");
  const store = openCatalogStore(path, { now: testNow });
  try {
    const raw = new Database(path, { readonly: true });
    try {
      expect(
        raw
          .query(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          )
          .all(),
      ).toEqual([{ name: "policy" }, { name: "session_index" }]);
    } finally {
      raw.close();
    }
  } finally {
    store.close();
    store.close();
    rmSync(directory, { recursive: true });
  }
});

// W5.2 review F9: same busy-first proof as the session file — busy_timeout is
// connection-local, so seeing 5000 after the NOTADB throw proves it ran before
// any file-touching schema statement.
test("F9: catalog bootstrap applies busy_timeout before any schema statement", () => {
  expectBusyBeforeSchema(CATALOG_SCHEMA);
});

test("session index registers at fence 0, rotates monotonically and refuses unknown sessions", () => {
  const directory = mkdtempSync(join(tmpdir(), "catalog-store-"));
  const store = openCatalogStore(join(directory, "catalog.sqlite"), { now: testNow });
  try {
    const registration: SessionIndexInsert = {
      id: "s1",
      parentId: null,
      role: "resident",
      createdAt: 1,
    };
    expect(store.indexSession(registration)).toBe(true);
    const registered: SessionIndexRow = {
      id: "s1",
      parentId: null,
      role: "resident",
      fence: 0,
      createdAt: 1,
      hasArmed: false,
    };
    expect(store.sessionIndex("s1")).toEqual(registered);
    expect(store.rotateFence("s1")).toBe(1);
    expect(store.rotateFence("s1")).toBe(2);
    // A lost registration race is not an error and never resets the fence.
    expect(store.indexSession({ id: "s1", parentId: null, role: "resident", createdAt: 9 })).toBe(
      false,
    );
    expect(store.sessionIndex("s1")?.fence).toBe(2);
    expect(store.sessionIndex("ghost")).toBeUndefined();
    expect(() => store.rotateFence("ghost")).toThrow(
      expect.objectContaining({ _tag: "SessionNotFound", sessionId: "ghost" }),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test("child session pages preserve id order and enforce a bounded page size", () => {
  const store = openCatalogStore(":memory:", { now: testNow });
  try {
    for (const [id, parentId] of [["b", "root"], ["a", "root"], ["c", "root"], ["else", "other"]] as const) {
      store.indexSession({ id, parentId, role: "child", createdAt: 1 });
    }
    expect(store.childSessionsPage("root", "", 2).map((row) => row.id)).toEqual(["a", "b"]);
    expect(store.childSessionsPage("root", "b", 2).map((row) => row.id)).toEqual(["c"]);
    expect(() => store.childSessionsPage("root", "", 0)).toThrow(z.ZodError);
    expect(() => store.childSessionsPage("root", "", 257)).toThrow(z.ZodError);
  } finally {
    store.close();
  }
});

// W5.2 review F5: the fence rotation is a CAS — two concurrent activations from
// separate processes must observe distinct, consecutive fences whatever the
// interleaving. Each child opens its own CatalogStore handle on the same file.
test("concurrent rotateFence from two processes yields distinct consecutive fences", async () => {
  const directory = mkdtempSync(join(tmpdir(), "catalog-store-"));
  const path = join(directory, "catalog.sqlite");
  const store = openCatalogStore(path, { now: testNow });
  try {
    store.indexSession({ id: "s1", parentId: null, role: "resident", createdAt: 1 });
    const childSource = `
      import { openCatalogStore } from "./src/core/store/catalog.ts";
      const store = openCatalogStore(String(process.env.CATALOG_PATH), { now: () => 1_700_000_000_000 });
      const fence = store.rotateFence("s1");
      store.close();
      process.stdout.write(String(fence)); // a plain string never takes color
    `;
    const children = [1, 2].map(() =>
      Bun.spawn([process.execPath, "-e", childSource], {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, CATALOG_PATH: path },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      children.map(async (child) => ({
        exitCode: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      })),
    );
    for (const result of results) {
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    }
    expect(results.map((result) => Number(result.stdout.trim())).sort()).toEqual([1, 2]);
    expect(store.sessionIndex("s1")?.fence).toBe(2);
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test("catalog sub-adapters operate on the fresh catalog tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "catalog-store-"));
  const store = openCatalogStore(join(directory, "catalog.sqlite"), { now: testNow });
  try {
    expect(store.policies.append(policyFixture)).toBe(true);
    expect(store.policies.append(policyFixture)).toBe(false);
    expect(store.policies.rows()).toEqual([policyFixture]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});
