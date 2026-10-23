import { policySnapshot } from "../../../packages/agent/test/helpers/compiled-policy";
import { expect, test } from "bun:test";
import { Core } from "@oni/agent";
const KERNEL_POLICY_REGISTRY = Core.KERNEL_POLICY_REGISTRY;
const SEEDED_POLICY_ROWS = Core.SEEDED_POLICY_ROWS;
import type { PolicyRow } from "@oni/protocol";
import { monitorBundle } from "../src/bundles/alarms/monitor/index";
import { gateRowPolicySeeds } from "../src/bundles/core-policy/index";
import { SHIPPED_OWNER_POLICY, seedKernelPolicyRows } from "../src/composition/policy";
import { testPlane } from "./helpers/ledger";

// #1308: the wake-budget seed is the composed bundle row, projected the same
// way the boot seeds it (gateRowPolicySeeds over the composed generation).
const monitorRows = gateRowPolicySeeds({
  rows: monitorBundle({ close: () => undefined }, () => undefined).rows,
  handlers: new Map(),
});

test("the ledger writer seeds generation one with mandatory rows and identical reseeding is a no-op", () => {
  const source = testPlane().catalog.policies;
  // #1255 P2: the wake budget is the monitor bundle's row, passed by the boot.
  expect(seedKernelPolicyRows(source.appendGeneration.bind(source), monitorRows)).toBe(1);
  const first = source.rows();
  for (const row of [...SEEDED_POLICY_ROWS, ...SHIPPED_OWNER_POLICY.rows]) {
    expect(first).toContainEqual({ ...row, generation: 1 });
  }
  expect(first.find((row: PolicyRow.Row) => row.name === "monitor/tool.pre#1"))
    .toMatchObject({ generation: 1, verdict: { value: { ref: "kernel/budget-clamp" } } });
  expect(seedKernelPolicyRows(source.appendGeneration.bind(source), monitorRows)).toBe(1);
  expect(source.rows()).toEqual(first);
  expect(source.rows(2)).toEqual([]);
});

test("an unresolved named ref in a ledger generation refuses compilation with typed fields", () => {
  const source = testPlane().catalog.policies;
  const generation = seedKernelPolicyRows(source.appendGeneration.bind(source), [{
    name: "missing-ref", kind: "tool", phase: "pre", priority: 1000,
    match: { encodingVersion: 1, value: { op: "provision" } },
    verdict: { encodingVersion: 1, value: { type: "transform", ref: "app/not-registered" } },
  }]);
  expect(() => policySnapshot({
    rows: source.rows(generation), generation, registry: KERNEL_POLICY_REGISTRY,
  })).toThrow(expect.objectContaining({
    data: expect.objectContaining({
      code: "unknown_ref", generation: 1, ruleName: "missing-ref", ref: "app/not-registered",
    }),
  }));
});
