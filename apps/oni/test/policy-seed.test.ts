import { policySnapshot } from "../../../packages/agent/test/helpers/compiled-policy";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "@oni/agent";
const SEEDED_POLICY_ROWS = Core.SEEDED_POLICY_ROWS;
import { openCatalogStore } from "../../../packages/agent/src/core/store/catalog";
import type { PolicyRow } from "@oni/protocol";
import { gateRowPolicySeeds } from "../src/bundles/core-policy/index";
import { SHIPPED_OWNER_POLICY, seedKernelPolicyRows } from "../src/composition/policy";
import { monitorBundle } from "../src/bundles/alarms/monitor/index";
import { testClock } from "./helpers/test-entropy";

// #1308: the wake-budget seed is the composed bundle row, projected the same
// way the boot seeds it (gateRowPolicySeeds over the composed generation).
const monitorRows = gateRowPolicySeeds({
  rows: monitorBundle({ close: () => undefined }, () => undefined).rows,
  handlers: new Map(),
});

const identity = (row: Omit<PolicyRow.Row, "generation">) =>
  JSON.stringify([row.name, row.kind, row.phase]);
const budgetId = JSON.stringify(["monitor/tool.pre#1", "tool", "pre"]);
// #1255 P2: the wake budget is the monitor bundle's row, passed by the boot.
const expectedIds = [
  ...SEEDED_POLICY_ROWS.map(identity),
  ...SHIPPED_OWNER_POLICY.rows.map(identity),
  ...monitorRows.map(identity),
  identity(Core.POINT_GENERATION_ROW),
].sort();

type CatalogStore = ReturnType<typeof openCatalogStore>;

function withDatabase(run: (open: () => CatalogStore, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "policy-seed-"));
  const path = join(directory, "catalog.sqlite");
  const opened: CatalogStore[] = [];
  const open = () => {
    const catalog = openCatalogStore(path, { now: testClock() });
    opened.push(catalog);
    return catalog;
  };
  try {
    run(open, path);
  } finally {
    for (const catalog of opened) catalog.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("interrupted policy promotion rolls back every row and reopens with the complete generation", () => {
  withDatabase((open, path) => {
    const first = open();
    const adapter = first.policies;
    for (const row of SEEDED_POLICY_ROWS) {
      expect(adapter.append({ ...row, generation: 1 })).toBe(true);
    }
    const original = adapter.rows(1);
    const fault = new Database(path);
    try {
      fault.run(`CREATE TRIGGER fail_partial_policy BEFORE INSERT ON policy
        WHEN NEW.generation = 2 AND (SELECT COUNT(*) FROM policy WHERE generation = 2) = 1
        BEGIN SELECT RAISE(ABORT, 'policy-upgrade-fault'); END`);
      expect(() => seedKernelPolicyRows(adapter, monitorRows)).toThrow("policy-upgrade-fault");
      expect(adapter.rows(2)).toEqual([]);
      expect(adapter.rows()).toEqual(original);
      fault.run("DROP TRIGGER fail_partial_policy");
    } finally {
      fault.close();
    }
    first.close();
    const reopened = open().policies;
    expect(seedKernelPolicyRows(reopened, monitorRows)).toBe(2);
    expect(reopened.rows(2).map(identity).sort()).toEqual(expectedIds);
    expect(reopened.rows(1)).toEqual(original);
    const complete = reopened.rows();
    expect(seedKernelPolicyRows(reopened, monitorRows)).toBe(2);
    expect(reopened.rows()).toEqual(complete);
  });
});

test("budget presence alone does not complete a generation; preserve existing policy content", () => {
  withDatabase((open) => {
    const policies = open().policies;
    expect(seedKernelPolicyRows(policies, monitorRows)).toBe(1);
    expect(policies.rows(1).map(identity).sort()).toEqual(expectedIds);
    const budget = policies
      .rows(1)
      .find((row) => identity(row) === budgetId);
    if (budget === undefined) throw new Error("missing seeded budget");
    const custom = { ...budget, name: "site-policy", priority: 42, generation: 2 };
    expect(policies.append({ ...budget, generation: 2 })).toBe(true);
    expect(policies.append(custom)).toBe(true);
    expect(seedKernelPolicyRows(policies, monitorRows)).toBe(3);
    expect(policies.rows(3).map(identity).sort()).toEqual(
      [...expectedIds, identity(custom)].sort(),
    );
    expect(policies.rows(3)).toContainEqual({ ...custom, generation: 3 });
    expect(policies.rows(3)).toContainEqual({ ...budget, generation: 3 });
    const complete = policies.rows();
    expect(seedKernelPolicyRows(policies, monitorRows)).toBe(3);
    expect(policies.rows()).toEqual(complete);
  });
});

test("a complete latest generation plus an unmappable row still rejects the boot (#1251 r1)", () => {
  withDatabase((open) => {
    const policies = open().policies;
    expect(seedKernelPolicyRows(policies, monitorRows)).toBe(1);
    // Generation 2 carries every current row (so the identity early return
    // would hold) plus one unmappable custom row: validation must run first.
    for (const row of policies.rows(1)) expect(policies.append({ ...row, generation: 2 })).toBe(true);
    const budget = policies.rows(1).find((row) => identity(row) === budgetId);
    if (budget === undefined) throw new Error("missing seeded budget");
    expect(
      policies.append({ ...budget, name: "orphan-checkpoint", kind: "fold.checkpoint", generation: 2 }),
    ).toBe(true);
    const before = policies.rows();
    try {
      seedKernelPolicyRows(policies, monitorRows);
      throw new Error("expected unknown_point");
    } catch (error) {
      if (!Core.GateComposeError.isInstance(error)) throw error;
      expect(error.data).toEqual({ code: "unknown_point", point: "fold.checkpoint.pre" });
    }
    expect(policies.rows()).toEqual(before);
  });
});

test("a base-era compaction deny refuses boot until the policy rows are converted offline", () => {
  withDatabase((open) => {
    const policies = open().policies;
    expect(seedKernelPolicyRows(policies, monitorRows)).toBe(1);
    // Generation 2: the complete current rows plus a base-era deny written
    // against the old turn envelope (`turn/post` matching `op: compaction`).
    for (const row of policies.rows(1)) expect(policies.append({ ...row, generation: 2 })).toBe(true);
    expect(
      policies.append({
        name: "no-summaries",
        kind: "turn",
        phase: "post",
        match: { encodingVersion: 1, value: { op: "compaction" } },
        verdict: { encodingVersion: 1, value: { type: "deny", reason: "no summaries" } },
        priority: 2_000,
        generation: 2,
      }),
    ).toBe(true);
    const historical = JSON.stringify(policies.rows(2));

    expect(() => seedKernelPolicyRows(policies, monitorRows)).toThrow(expect.objectContaining({
      data: expect.objectContaining({
        code: "policy_row_migration_required",
        ruleName: "no-summaries",
        procedureId: "policy-point-rows-v1",
      }),
    }));
    expect(JSON.stringify(policies.rows(2))).toBe(historical);
    policies.appendGeneration((current) => current.map((row) => row.name === "no-summaries"
      ? { ...row, kind: "compaction", phase: "pre" as const, match: { encodingVersion: 1 as const, value: { op: "compact" } } }
      : row));
    expect(seedKernelPolicyRows(policies, monitorRows)).toBe(3);
    // Historical bytes untouched; the latest generation carries the converted row.
    expect(JSON.stringify(policies.rows(2))).toBe(historical);
    expect(policies.rows(3).find((row) => row.name === "no-summaries")).toMatchObject({
      kind: "compaction",
      phase: "pre",
    });

    // The production compiler refuses summarization under the converted generation.
    const refused = policySnapshot({
      rows: policies.rows(3), generation: 3, registry: Core.KERNEL_POLICY_REGISTRY,
    }).evaluate({ kind: "compaction", phase: "pre", op: "compact", value: {} });
    expect(refused.verdict).toBe("deny");

    // Reseeding converges: the converted generation is already in point shape.
    expect(seedKernelPolicyRows(policies, monitorRows)).toBe(3);
  });
});

test("a latest generation with an unmappable row rejects the boot conversion and keeps the catalog intact", () => {
  withDatabase((open) => {
    const policies = open().policies;
    expect(seedKernelPolicyRows(policies, monitorRows)).toBe(1);
    const budget = policies.rows(1).find((row) => identity(row) === budgetId);
    if (budget === undefined) throw new Error("missing seeded budget");
    expect(
      policies.append({ ...budget, name: "orphan-checkpoint", kind: "fold.checkpoint", generation: 2 }),
    ).toBe(true);
    const before = policies.rows();
    try {
      seedKernelPolicyRows(policies, monitorRows);
      throw new Error("expected unknown_point");
    } catch (error) {
      if (!Core.GateComposeError.isInstance(error)) throw error;
      expect(error.data).toEqual({ code: "unknown_point", point: "fold.checkpoint.pre" });
    }
    expect(policies.rows()).toEqual(before);
  });
});
