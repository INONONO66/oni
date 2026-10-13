import { expect, test } from "bun:test";
import type { Bundle } from "@openomni/agent";
import { AppInvariantError } from "../src/invariant";
import { gateRowPolicySeeds } from "../src/bundles/core-policy/index";

const row = (over: Partial<Bundle.BundleGateRow>): Bundle.BundleGateRow => ({
  id: "probe/tool.pre#1",
  on: "tool.pre",
  when: { op: "monitor" },
  do: "gate",
  how: {},
  order: 7,
  ...over,
});

/** Seeds read the generation slice; tests fake it (#1256 r4 H-2). */
const generationOf = (
  rows: readonly Bundle.BundleGateRow[],
  handlers: ReadonlyMap<string, object> = new Map(),
) => ({ rows, handlers });

test("gate rows project onto the legacy seed shape: obligation, constant verdicts and transforms", () => {
  const seeds = gateRowPolicySeeds(generationOf([
    row({ how: { ref: "kernel/budget-clamp", metric: "notifications", limit: 8 } }),
    row({ id: "probe/tool.pre#2", how: {} }),
    row({ id: "probe/tool.pre#3", how: { verdict: "require_approval" } }),
    row({ id: "probe/tool.pre#4", do: "rewrite", how: { ref: "probe/redact" } }),
    row({
      id: "probe/tool.pre#5",
      do: "rewrite",
      how: { ref: "probe/redact", params: { keys: ["token"] } },
    }),
    row({ id: "probe/alarm.fired#1", on: "alarm.fired", when: {}, how: { verdict: "deny" } }),
    // #1256: hook rows — a consulted gate guard and the audit-only observe.
    row({ id: "probe/tool.pre#6", how: { ref: "hook/process", params: { event: "PreToolUse" } } }),
    row({
      id: "probe/tool.post#1",
      on: "tool.post",
      do: "observe",
      how: { ref: "hook/process", params: { event: "PostToolUse" } },
    }),
  ]));
  expect(seeds.map((seed) => [seed.name, seed.kind, seed.phase, seed.priority])).toEqual([
    ["probe/tool.pre#1", "tool", "pre", 7],
    ["probe/tool.pre#2", "tool", "pre", 7],
    ["probe/tool.pre#3", "tool", "pre", 7],
    ["probe/tool.pre#4", "tool", "pre", 7],
    ["probe/tool.pre#5", "tool", "pre", 7],
    ["probe/alarm.fired#1", "alarm.fired", "post", 7],
    ["probe/tool.pre#6", "tool", "pre", 7],
    ["probe/tool.post#1", "tool", "post", 7],
  ]);
  expect(seeds.map((seed) => seed.verdict.value)).toEqual([
    { type: "obligation", ref: "kernel/budget-clamp", metric: "notifications", limit: 8 },
    { type: "allow" },
    { type: "require_approval", reason: "probe/tool.pre#3" },
    { type: "transform", ref: "probe/redact" },
    { type: "transform", ref: "probe/redact", config: { keys: ["token"] } },
    { type: "deny" },
    { type: "consult", ref: "hook/process", config: { event: "PreToolUse" } },
    { type: "consult", ref: "hook/process", observe: true, config: { event: "PostToolUse" } },
  ]);
  expect(seeds[0]?.match).toEqual({ encodingVersion: 1, value: { op: "monitor" } });
});

test("a rewrite row naming a registered consultant seeds consult{rewrite}; a sync ref keeps the transform seed (#1256 r4 H-2)", () => {
  const handlers = new Map<string, object>([
    ["hook/process", { consultant: () => undefined }],
  ]);
  const seeds = gateRowPolicySeeds(
    generationOf(
      [
        row({
          id: "probe/tool.pre#1",
          do: "rewrite",
          how: {
            ref: "hook/process",
            fields: ["command"],
            params: { event: "PreToolUse", command: ["./mask.sh"], timeoutMs: 1_000, fields: ["command"] },
          },
        }),
        // The same shape over a NON-consultant ref stays the sync transform seed.
        row({ id: "probe/tool.pre#2", do: "rewrite", how: { ref: "probe/redact", fields: ["command"] } }),
      ],
      handlers,
    ),
  );
  expect(seeds.map((seed) => seed.verdict.value)).toEqual([
    {
      type: "consult",
      ref: "hook/process",
      rewrite: true,
      config: { event: "PreToolUse", command: ["./mask.sh"], timeoutMs: 1_000, fields: ["command"] },
    },
    { type: "transform", ref: "probe/redact" },
  ]);
});

test("a consulted gate row without budget fields seeds as a consult verdict (#1258)", () => {
  const seeds = gateRowPolicySeeds(
    generationOf([row({ how: { ref: "delegation-policy/spawn-depth", params: { limit: 3 } } })]),
  );
  expect(seeds[0]?.verdict.value).toEqual({
    type: "consult",
    ref: "delegation-policy/spawn-depth",
    config: { limit: 3 },
  });
});
test("a row the live plane cannot seed is an invariant failure, never a silent default", () => {
  expect(() => gateRowPolicySeeds(generationOf([row({ how: { ref: "kernel/budget-clamp" } })]))).toThrow(
    AppInvariantError,
  );
  expect(() => gateRowPolicySeeds(generationOf([row({ do: "emit", how: { emit: "message" } })]))).toThrow(
    "has no live policy-plane seed shape",
  );
  expect(() =>
    gateRowPolicySeeds(generationOf([row({ on: "ghost.pre" as Bundle.BundleGateRow["on"] })])),
  ).toThrow("has no legacy policy address");
});
