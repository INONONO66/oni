import { compile, KERNEL_POLICY_REGISTRY } from "../../../src/core/gate/compile";
import { bind } from "../../../src/core/gate/bind";
import { policySnapshot } from "../../helpers/compiled-policy";
import type { PolicyEvaluationInput } from "../../../src/core/gate/types";
import { describe, expect, it } from "bun:test";

import type { PolicyRow, Storage } from "@oni/protocol";
import { atGeneration, compaction, draft, MemoryPolicyRows, unrelatedRows, withPolicyRows } from "./row-fixtures";

const request: PolicyEvaluationInput = {
  kind: "tool",
  phase: "pre",
  op: "read",
  role: "resident",
  sessionId: "session-1",
  value: { path: "/workspace/readme.md" },
};

function initialRows() {
  return [
    atGeneration(compaction, 1),
    atGeneration(
      draft("redact-password", "tool", "post", {
        type: "transform",
        ref: "kernel/redact",
        config: {
          paths: ["password"],
        },
      }),
      1,
    ),
    atGeneration(
      draft("allow-read", "tool", "pre", { type: "allow" }, { match: { op: "read" } }),
      1,
    ),
  ];
}

describe("compiled policy snapshot determinism", () => {
  it("pins a turn while the transactional writer advances new evaluators", () => withPolicyRows((source: Storage.PolicyRowSubAdapter) => {
    source.appendGeneration(() => initialRows());
    const oldEvaluator = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY, rows: source.rows(1), generation: 1,
      mandatory: ["compaction"],
    });
    const before = oldEvaluator.evaluate(request);

    const generation = source.appendGeneration((current: readonly PolicyRow.Row[]) => [
      ...current,
      draft(
        "deny-read",
        "tool",
        "pre",
        { type: "deny", reason: "read suspended" },
        { match: { op: "read" }, priority: 2_000 },
      ),
    ]);
    const current = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY, rows: source.rows(generation), generation,
      mandatory: ["compaction"],
    });
    expect(generation).toBe(2);
    expect(before.verdict).toBe("allow");
    expect(current.evaluate(request)).toMatchObject({
      generation: 2,
      verdict: "deny",
      matchedRuleIds: ["deny-read", "allow-read"],
      reason: "read suspended",
    });
    expect(oldEvaluator.evaluate(request)).toEqual(before);
  }));

  it("derives the same content hash and result regardless of insertion order", () => {
    const rows = initialRows();
    const forward = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows,
      mandatory: ["compaction"],
    });
    const reverse = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: [...rows].reverse(),
      mandatory: ["compaction"],
    });

    expect(forward.contentHash).toBe(reverse.contentHash);
    expect(forward.evaluate(request)).toEqual(reverse.evaluate(request));
  });

  it("captures immutable row data without freezing caller-owned rows", () => {
    const rows = initialRows();
    const snapshot = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows,
      mandatory: ["compaction"],
    });
    const before = snapshot.evaluate(request);
    const readRule = rows.find((row: PolicyRow.Row) => row.name === "allow-read");
    if (readRule === undefined) throw new Error("missing read rule fixture");

    expect(Object.isFrozen(readRule)).toBe(false);
    readRule.name = "mutated";
    readRule.priority = 10_000;
    readRule.match.value = { op: "write" };

    expect(snapshot.evaluate(request)).toEqual(before);
  });

  it("keeps an existing binding unchanged when its published row is mutated", () => {
    const rows = [
      ...initialRows(),
      atGeneration(draft("deny-read", "tool", "pre", { type: "deny", reason: "blocked" },
        { match: { op: "read" }, priority: 2_000 }), 1),
    ];
    const snapshot = compile({ rows, generation: 1,
      mandatory: ["compaction"] }, KERNEL_POLICY_REGISTRY);
    const binding = bind(snapshot);
    const before = binding.evaluate(request);
    const entry = snapshot.byPoint.get("tool.pre")?.find((candidate) => candidate.policy?.name === "deny-read");
    expect(entry?.policy?.name).toBe("deny-read");
    expect(before.verdict).toBe("deny");
    expect(() => Object.assign(entry?.row.how ?? {}, { verdict: "allow" })).toThrow(TypeError);
    expect(Object.isFrozen(entry?.row.when)).toBe(true);
    expect(Object.isFrozen(snapshot.byPoint.get("tool.pre"))).toBe(true);
    expect(Reflect.get(snapshot.byPoint, "set")).toBeUndefined();
    const after = binding.evaluate(request);
    expect(after).toEqual(before);
    expect([after.generation, after.snapshotHash, after.inputHash]).toEqual([
      before.generation, before.snapshotHash, before.inputHash,
    ]);
  });

  it("captures verdict data without aliasing caller-owned nested values", () => {
    const verdict = {
      type: "transform",
      ref: "kernel/redact",
      config: {
        paths: ["credentials.password"],
        replacement: "[redacted]",
      },
    };
    const row = draft("redact-credentials", "tool", "post", verdict);
    const snapshot = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: [atGeneration(compaction, 1), atGeneration(row, 1)],
      mandatory: ["compaction"],
    });
    const requestWithCredentials: PolicyEvaluationInput = {
      ...request,
      phase: "post",
      value: { credentials: { password: "secret", token: "keep" } },
    };
    const before = snapshot.evaluate(requestWithCredentials);

    verdict.type = "deny";
    verdict.config.paths[0] = "credentials.token";

    expect(snapshot.evaluate(requestWithCredentials)).toEqual(before);
    expect(snapshot.evaluate(requestWithCredentials)).toMatchObject({
      verdict: "transform",
      value: { credentials: { password: "[redacted]", token: "keep" } },
    });
  });

  it("reads exactly one kind/phase/op bucket and never reads storage on the hot path", () => {
    const unrelated = unrelatedRows(220);
    const source = new MemoryPolicyRows([...initialRows(), ...unrelated]);
    const evaluator = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY, rows: source.rows(1), generation: 1,
      mandatory: ["compaction"],
    });
    const readsBefore = source.reads;

    for (let index = 0; index < 1_000; index += 1) evaluator.evaluate(request);
    const decision = evaluator.evaluate(request);

    expect(source.reads).toBe(readsBefore);
    expect(decision.matchedRuleIds).toEqual(["allow-read"]);
  });
});
