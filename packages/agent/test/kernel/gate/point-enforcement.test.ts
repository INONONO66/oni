import { KERNEL_POLICY_REGISTRY, PolicyCompileError, SEEDED_POLICY_ROWS } from "../../../src/core/gate/compile";
import { policySnapshot } from "../../helpers/compiled-policy";
import type { PolicyEvaluationInput } from "../../../src/core/gate/types";
import { describe, expect, it, mock } from "bun:test";

import type { PolicyRow, Storage } from "@oni/protocol";
import { atGeneration, compaction, draft, MemoryPolicyRows, withPolicyRows, type PolicyRowDraft } from "./row-fixtures";

const input: PolicyEvaluationInput = {
  kind: "tool",
  phase: "pre",
  op: "write",
  role: "resident",
  sessionId: "session-1",
  value: { path: "/tmp/result" },
};

const detachedPolicyCompileErrorGuard = PolicyCompileError.isInstance;

function preservesPolicyCompileErrorNarrowing<Input>(
  error: Input,
): (Input & PolicyCompileError) | undefined {
  if (detachedPolicyCompileErrorGuard(error)) {
    return error;
  }
  return undefined;
}

describe("policy row compiler enforcement", () => {
  it("narrows detached guards to PolicyCompileError", () => {
    const error = new PolicyCompileError({
      code: "snapshot_load_failed",
      generation: 1,
      ruleName: "load",
    });
    expect(preservesPolicyCompileErrorNarrowing(error)?.code).toBe("snapshot_load_failed");
    expect(error.generation).toBe(1);
    expect(error.ruleName).toBe("load");
  });

  it("cannot disable the mandatory rule and fails closed with exact fields", () => {
    expect(() =>
      policySnapshot({
        registry: KERNEL_POLICY_REGISTRY,
        generation: 1,
        rows: [],
        mandatory: [],
      }),
    ).toThrow(expect.objectContaining({
      data: expect.objectContaining({
        code: "mandatory_rule_missing",
        generation: 1,
        ruleName: "compaction",
        message: "policy generation 1 is missing mandatory rule compaction",
      }),
    }));
  });

  it("propagates storage load failure before compiling or invoking a body", () => {
    const source: MemoryPolicyRows = new MemoryPolicyRows();
    source.rows = () => {
      throw new Error("database unavailable");
    };
    const body = mock(() => "must not run");
    expect(() => policySnapshot({
      registry: KERNEL_POLICY_REGISTRY, rows: source.rows(9), generation: 9,
      mandatory: ["compaction"],
    }).evaluate(input)).toThrow("database unavailable");
    expect(body).toHaveBeenCalledTimes(0);
  });

  it("preserves exact compile failures after storage loads", () => {
    const source = new MemoryPolicyRows([
      atGeneration(compaction, 1),
      atGeneration(draft("bad-kind", "extension.unregistered", "pre", { type: "allow" }), 1),
    ]);
    expect(() => policySnapshot({
      registry: KERNEL_POLICY_REGISTRY, rows: source.rows(1), generation: 1,
      mandatory: ["compaction"],
    })).toThrow(expect.objectContaining({
      data: expect.objectContaining({
        code: "unknown_kind", generation: 1, ruleName: "bad-kind",
      }),
    }));
  });

  it.each([
    ["kind", draft("bad-kind", "extension.unregistered", "pre", { type: "allow" }), "unknown_kind"],
    [
      "transformer",
      draft("bad-transform", "tool", "post", { type: "transform", ref: "demo/not-registered" }),
      "unknown_ref",
    ],
    [
      "obligation",
      draft("bad-obligation", "tool", "pre", {
        type: "obligation",
        ref: "demo/not-registered",
        metric: "fanout",
        limit: 2,
      }),
      "unknown_ref",
    ],
  ] as const)("rejects an unregistered %s with exact machine fields", (_label: string, badRow: PolicyRowDraft, code: PolicyCompileError["code"]) => {
    expect(() =>
      policySnapshot({
        registry: KERNEL_POLICY_REGISTRY,
        generation: 1,
        rows: [atGeneration(compaction, 1), atGeneration(badRow, 1)],
        mandatory: ["compaction"],
      }),
    ).toThrow(expect.objectContaining({
      data: expect.objectContaining({ code, generation: 1, ruleName: badRow.name }),
    }));
  });

  it.each([
    ["generation_mismatch", atGeneration(compaction, 2)],
    [
      "invalid_match",
      atGeneration(draft("bad-match", "tool", "pre", { type: "allow" }, { match: { op: "" } }), 1),
    ],
    [
      "invalid_verdict",
      atGeneration(draft("bad-verdict", "tool", "pre", { type: "unexpected" }), 1),
    ],
  ] as const)("rejects malformed rows with %s", (code: PolicyCompileError["code"], badRow: PolicyRow.Row) => {
    expect(() =>
      policySnapshot({
        registry: KERNEL_POLICY_REGISTRY,
        generation: 1,
        rows: [atGeneration(compaction, 1), badRow],
        mandatory: ["compaction"],
      }),
    ).toThrow(expect.objectContaining({
      data: expect.objectContaining({ code }),
    }));
  });

  it("a lower-priority deny beats a higher-priority approval and both ids are recorded (#1251 r2)", () => {
    const snapshot = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: [
        atGeneration(compaction, 1),
        atGeneration(
          draft("approval", "tool", "pre", { type: "require_approval", reason: "operator" }, { priority: 2_000 }),
          1,
        ),
        atGeneration(
          draft("deny-low", "tool", "pre", { type: "deny", reason: "blocked" }, { priority: 1_000 }),
          1,
        ),
      ],
    });
    expect(snapshot.evaluate(input)).toMatchObject({
      verdict: "deny",
      matchedRuleIds: ["approval", "deny-low"],
      reason: "blocked",
    });
  });

  it("requires approval before lower-priority rules can allow", () => {
    const snapshot = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: [
        atGeneration(compaction, 1),
        atGeneration(
          draft(
            "approval",
            "tool",
            "pre",
            {
              type: "require_approval",
              reason: "operator",
            },
            { priority: 100 },
          ),
          1,
        ),
        atGeneration(draft("allow-after", "tool", "pre", { type: "allow" }), 1),
      ],
    });

    expect(snapshot.evaluate(input)).toMatchObject({
      verdict: "require_approval",
      matchedRuleIds: ["approval", "allow-after"],
      reason: "operator",
    });
  });

  it("skips redaction paths that traverse non-objects", () => {
    const snapshot = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: [
        atGeneration(compaction, 1),
        atGeneration(
          draft("redact", "tool", "post", {
            type: "transform",
            ref: "kernel/redact",
            config: {
              paths: ["secret.token.value", "list.token.value", "missing.token"],
            },
          }),
          1,
        ),
      ],
    });

    expect(
      snapshot.evaluate({ ...input, phase: "post", value: { secret: null, list: [] } }).value,
    ).toEqual({
      secret: null,
      list: [],
    });
  });

  it("rolls back the entire generation on a conflicting row with typed identity", () => withPolicyRows((source: Storage.PolicyRowSubAdapter) => {
    source.appendGeneration(() => [compaction]);
    const before = source.rows();
    expect(() => source.appendGeneration(() => [compaction, compaction])).toThrow(expect.objectContaining({
      _tag: "PolicyGenerationRefused", reason: "conflict", generation: 2, ruleName: "compaction",
    }));
    expect(source.rows()).toEqual(before);
    expect(source.appendGeneration(() => [compaction])).toBe(2);
  }));

  it("refuses empty generations and leaves no durable or cached partial snapshot", () => withPolicyRows((source: Storage.PolicyRowSubAdapter) => {
    expect(() => source.appendGeneration(() => [])).toThrow(expect.objectContaining({
      _tag: "PolicyGenerationRefused", reason: "empty", generation: 1,
    }));
    expect(source.rows()).toEqual([]);
    expect(source.appendGeneration(() => [compaction])).toBe(1);
    const snapshot = policySnapshot({ registry: KERNEL_POLICY_REGISTRY, rows: source.rows(1), generation: 1 });
    expect(snapshot.evaluate(input).verdict).toBe("allow");
    expect(source.appendGeneration(() => undefined)).toBe(1);
  }));

  it("ships every kernel limit as seeded policy data", () => {
    const snapshot = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: SEEDED_POLICY_ROWS.map((row: PolicyRowDraft) => atGeneration(row, 1)),
    });
    const cases = [
      ["turn", "post", "continue", "continuation", 8],
      ["tool", "pre", "send_message", "fanout", 8],
      ["turn", "post", "exact_repeat", "exact_repeat", 3],
      ["turn", "post", "toolless_stall", "toolless_stall", 3],
      ["turn", "post", "blocked_recurrence", "blocked_recurrence", 3],
      ["turn", "pre", "resume", "resume", 10],
    ] as const;

    for (const [kind, phase, op, metric, limit] of cases) {
      expect(snapshot.evaluate({ ...input, kind, phase, op }).obligations).toEqual([
        { ref: "kernel/budget-clamp", metric, limit },
      ]);
    }
  });

  it("runs the named redactor only at complete object paths", () => {
    const snapshot = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: [
        atGeneration(compaction, 1),
        atGeneration(
          draft("redact-token", "tool", "post", {
            type: "transform",
            ref: "kernel/redact",
            config: {
              paths: ["secret.token", "missing.token"],
              replacement: "[redacted]",
            },
          }),
          1,
        ),
      ],
    });

    expect(
      snapshot.evaluate({
        ...input,
        phase: "post",
        value: { token: "keep", secret: { token: "remove" } },
      }),
    ).toMatchObject({
      verdict: "transform",
      matchedRuleIds: ["redact-token"],
      value: { token: "keep", secret: { token: "[redacted]" } },
    });
  });

  it("orders by descending priority and deny outranks every other matched rule", () => {
    const snapshot = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      mandatory: ["compaction"],
      rows: [
        atGeneration(compaction, 1),
        atGeneration(draft("low-allow", "tool", "pre", { type: "allow" }, { priority: 10 }), 1),
        atGeneration(draft("highest-allow", "tool", "pre", { type: "allow" }, { priority: 30 }), 1),
        atGeneration(
          draft(
            "middle-deny",
            "tool",
            "pre",
            { type: "deny", reason: "blocked" },
            { priority: 20 },
          ),
          1,
        ),
      ],
    });

    expect(snapshot.evaluate(input)).toMatchObject({
      verdict: "deny",
      matchedRuleIds: ["highest-allow", "middle-deny", "low-allow"],
      reason: "blocked",
    });
  });

  it("matches op-specific and wildcard rows in one deterministic priority stage", () => {
    const snapshot = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      mandatory: ["compaction"],
      rows: [
        atGeneration(compaction, 1),
        atGeneration(draft("wildcard", "tool", "pre", { type: "allow" }, { priority: 20 }), 1),
        atGeneration(
          draft(
            "write-only",
            "tool",
            "pre",
            { type: "deny" },
            { match: { op: "write" }, priority: 10 },
          ),
          1,
        ),
      ],
    });

    expect(snapshot.evaluate(input).matchedRuleIds).toEqual(["wildcard", "write-only"]);
    expect(snapshot.evaluate({ ...input, op: "read" }).matchedRuleIds).toEqual(["wildcard"]);
  });

  it("scopes a row to one inner operation of a multi-operation tool", () => {
    const snapshot = policySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: [
        atGeneration(compaction, 1),
        atGeneration(
          draft(
            "promote-consent",
            "tool",
            "pre",
            { type: "require_approval", reason: "owner consent" },
            { match: { op: "provision", operation: "contact_promote" }, priority: 10 },
          ),
          1,
        ),
      ],
    });
    const provision = (op: string) => ({
      ...input,
      op: "provision",
      value: { operation: { op, args: {} } },
    });

    expect(snapshot.evaluate(provision("contact_promote"))).toMatchObject({
      verdict: "require_approval",
      reason: "owner consent",
      matchedRuleIds: ["promote-consent"],
    });
    expect(snapshot.evaluate(provision("status"))).toMatchObject({
      verdict: "allow",
      matchedRuleIds: [],
    });
    expect(snapshot.evaluate({ ...input, op: "provision", value: [] }).verdict).toBe("allow");
  });
});
