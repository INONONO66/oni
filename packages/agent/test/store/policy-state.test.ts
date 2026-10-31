import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedgerPlane } from "../../src/core/session/host";
import { z } from "zod";
import { Database } from "bun:sqlite";

test("policy data is revision-fenced, namespace-scoped and survives reopening the catalog", () => {
  const directory = mkdtempSync(join(tmpdir(), "policy-state-"));
  const options = { now: () => 1, catalog: { path: join(directory, "catalog.sqlite") } };
  const plane = openLedgerPlane(options);
  try {
    const rows = plane.policyState;
    expect(rows.get("policy-a", "s1")).toBeUndefined();
    expect(rows.put("policy-a", { key: "s1", revision: 0, value: { state: "open" } })).toBe(true);
    expect(rows.put("policy-a", { key: "s1", revision: 0, value: "overwrite" })).toBe(false);
    expect(rows.put("policy-a", { key: "s1", revision: 2, value: "future" })).toBe(false);
    expect(rows.put("policy-a", { key: "s1", revision: 1, value: { state: "closed" } })).toBe(true);
    expect(rows.put("policy-b", { key: "s1", revision: 0, value: ["independent"] })).toBe(true);
    expect(rows.get("policy-a", "s1")).toEqual({ key: "s1", revision: 2, value: { state: "closed" } });
    expect(rows.list("policy-b")).toEqual([{ key: "s1", revision: 1, value: ["independent"] }]);
    expect(() => rows.put("policy-a", { key: "invalid", revision: -1, value: null })).toThrow(z.ZodError);
  } finally {
    plane.close();
  }
  const reopened = openLedgerPlane(options);
  try {
    expect(reopened.policyState.list("policy-a")).toEqual([{ key: "s1", revision: 2, value: { state: "closed" } }]);
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true });
  }
});

test("v5 catalogs add policy data without rebuilding session hints", () => {
  const directory = mkdtempSync(join(tmpdir(), "policy-state-v5-"));
  const path = join(directory, "catalog.sqlite");
  const options = { now: () => 1, catalog: { path } };
  const initial = openLedgerPlane(options);
  initial.catalog.indexSession({ id: "s1", parentId: null, role: "resident", createdAt: 1 });
  initial.close();
  const prior = new Database(path);
  prior.run("DROP TABLE policy_state");
  prior.run("PRAGMA user_version = 5");
  prior.close();
  const upgraded = openLedgerPlane(options);
  try {
    expect(upgraded.policyState.put("bundle", { key: "s1", revision: 0, value: "ready" })).toBe(true);
    expect(upgraded.catalog.requestFreeSessionIds()).toEqual(["s1"]);
  } finally {
    upgraded.close();
    rmSync(directory, { recursive: true });
  }
});
