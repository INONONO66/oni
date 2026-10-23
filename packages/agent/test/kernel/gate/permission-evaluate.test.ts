import { decisionFromEvaluation, evaluatePermission } from "../../../src/core/gate/bind";
import { describe, expect, test } from "bun:test";
import type { Policy } from "@oni/protocol";

const it = test;

describe("evaluatePermission", () => {
  const request = (
    resource: string,
    input?: Record<string, string | number | boolean | null>,
  ): Policy.EvaluationRequest => ({
    action: "tool.call",
    resource,
    ...(input !== undefined ? { input } : {}),
  });

  it("fails closed when input contains a non-JSON value", () => {
    expect(
      evaluatePermission(
        { action: "tool.call", inputRules: [{ toolPattern: "*", field: "value", pattern: "x", action: "allow", priority: 1 }] },
        // The typed wire schema now refuses functions at parse time; the runtime
        // evaluator must still fail closed on a value smuggled past the types.
        { ...request("tool"), input: { value: (() => "not JSON") as never } },
      ),
    ).toMatchObject({ action: "abort", decision: "deny", reason: "unsafe_input_rule" });
  });

  it("denies with the absent permission key in the reason", () => {
    expect(evaluatePermission(undefined, request("any_tool"))).toMatchObject({
      action: "abort",
      decision: "deny",
      reason: "default_deny:tool.call",
      policyId: "guardrail.permission",
    });
  });

  it("denies by default when a permission has no explicit grant", () => {
    expect(evaluatePermission({ action: "tool.call" }, request("any_tool"))).toMatchObject({
      action: "abort",
      decision: "deny",
      reason: "default_deny:tool.call",
      policyId: "guardrail.permission",
    });
  });

  it("aborts on action mismatch", () => {
    expect(evaluatePermission({ action: "task.create" }, request("any_tool"))).toMatchObject({
      action: "abort",
      decision: "deny",
      reason: "action_mismatch",
      policyId: "guardrail.permission",
    });
  });

  it("denies resources matched by denylist", () => {
    expect(
      evaluatePermission(
        { action: "tool.call", denylist: ["dangerous_tool"] },
        request("dangerous_tool"),
      ),
    ).toMatchObject({
      action: "abort",
      decision: "deny",
      reason: "denylist",
      policyId: "guardrail.permission",
      matchedPattern: "dangerous_tool",
    });
  });

  it("allows only resources matched by allowlist", () => {
    const permission = { action: "tool.call", allowlist: ["safe_tool"] };

    expect(evaluatePermission(permission, request("safe_tool"))).toMatchObject({
      action: "continue",
      decision: "allow",
      reason: "allowlist",
      policyId: "guardrail.permission",
    });
    expect(evaluatePermission(permission, request("other_tool"))).toMatchObject({
      action: "abort",
      decision: "deny",
      reason: "allowlist_miss",
      policyId: "guardrail.permission",
    });
  });

  it("evaluates resource labels after explicit deny and approval lists", () => {
    const permission: Policy.Permission = {
      action: "tool.call",
      allowLabels: ["capability:read"],
      denyLabels: ["capability:destructive"],
      requireApprovalLabels: ["risk:tier-2"],
    };

    expect(
      evaluatePermission(permission, {
        ...request("read"),
        resourceLabels: ["capability:read", "source:system"],
      }),
    ).toMatchObject({
      action: "continue",
      reason: "allow_label",
      matchedPattern: "capability:read",
    });

    expect(
      evaluatePermission(permission, {
        ...request("rm"),
        resourceLabels: ["capability:destructive", "risk:tier-2"],
      }),
    ).toMatchObject({
      action: "abort",
      decision: "deny",
      reason: "deny_label",
      matchedPattern: "capability:destructive",
    });

    expect(
      evaluatePermission(permission, {
        ...request("bash"),
        resourceLabels: ["risk:tier-2"],
      }),
    ).toMatchObject({
      action: "abort",
      decision: "require_approval",
      reason: "require_approval_label",
      matchedPattern: "risk:tier-2",
    });
  });

  it("aborts when allowlist is empty", () => {
    expect(
      evaluatePermission({ action: "tool.call", allowlist: [] }, request("safe_tool")),
    ).toMatchObject({
      action: "abort",
      reason: "allowlist_empty",
      policyId: "guardrail.permission",
    });
  });

  it("requires approval for matched resources", () => {
    expect(
      evaluatePermission(
        { action: "tool.call", requireApproval: ["sensitive_tool"] },
        request("sensitive_tool"),
      ),
    ).toMatchObject({
      action: "abort",
      decision: "require_approval",
      reason: "require_approval",
      policyId: "guardrail.permission",
      matchedPattern: "sensitive_tool",
    });
  });

  for (const { name, list, pattern, resource, expected } of [
    {
      name: "wildcard allowlist",
      list: "allowlist",
      pattern: "*",
      resource: "file.read",
      expected: {
        action: "continue",
        reason: "allowlist",
        policyId: "guardrail.permission",
        matchedPattern: "*",
      },
    },
    {
      name: "wildcard denylist",
      list: "denylist",
      pattern: "*",
      resource: "file.read",
      expected: {
        action: "abort",
        reason: "denylist",
        policyId: "guardrail.permission",
        matchedPattern: "*",
      },
    },
    {
      name: "wildcard approval",
      list: "requireApproval",
      pattern: "*",
      resource: "file.read",
      expected: {
        action: "abort",
        reason: "require_approval",
        policyId: "guardrail.permission",
        matchedPattern: "*",
      },
    },
    {
      name: "prefix allowlist",
      list: "allowlist",
      pattern: "file.*",
      resource: "file.read",
      expected: {
        action: "continue",
        reason: "allowlist",
        policyId: "guardrail.permission",
        matchedPattern: "file.*",
      },
    },
    {
      name: "prefix denylist",
      list: "denylist",
      pattern: "file.*",
      resource: "file.read",
      expected: {
        action: "abort",
        reason: "denylist",
        policyId: "guardrail.permission",
        matchedPattern: "file.*",
      },
    },
    {
      name: "prefix approval",
      list: "requireApproval",
      pattern: "file.*",
      resource: "file.read",
      expected: {
        action: "abort",
        reason: "require_approval",
        policyId: "guardrail.permission",
        matchedPattern: "file.*",
      },
    },
    {
      name: "prefix miss",
      list: "allowlist",
      pattern: "file.*",
      resource: "filesystem.read",
      expected: { action: "abort", reason: "allowlist_miss", policyId: "guardrail.permission" },
    },
  ] as const) {
    it(`matches ${name}`, () => {
      expect(
        evaluatePermission({ action: "tool.call", [list]: [pattern] }, request(resource)),
      ).toMatchObject(expected);
    });
  }

  it("gives denylist precedence over approval and allowlist matches", () => {
    expect(
      evaluatePermission(
        {
          action: "tool.call",
          allowlist: ["*"],
          denylist: ["file.*"],
          requireApproval: ["file.read"],
        },
        request("file.read"),
      ),
    ).toMatchObject({
      action: "abort",
      reason: "denylist",
      policyId: "guardrail.permission",
      matchedPattern: "file.*",
    });
  });

  it("uses the rule action when a matching input rule omits its reason", () => {
    expect(
      evaluatePermission(
        {
          action: "tool.call",
          inputRules: [
            {
              toolPattern: "bash",
              field: "command",
              pattern: "^echo",
              action: "allow",
              priority: 0,
            },
          ],
        },
        request("bash", { command: "echo safe" }),
      ),
    ).toMatchObject({ action: "continue", decision: "allow", reason: "input_rule_allow" });
  });

  it("distinguishes empty and missing allow-label matches", () => {
    expect(
      evaluatePermission({ action: "tool.call", allowLabels: [] }, request("bash")),
    ).toMatchObject({ action: "abort", reason: "allow_labels_empty" });
    expect(
      evaluatePermission(
        { action: "tool.call", allowLabels: ["capability:read"] },
        request("bash"),
      ),
    ).toMatchObject({ action: "abort", reason: "allow_labels_miss" });
  });

  it("preserves require_approval decision when an input rule supplies a custom reason", () => {
    const result = evaluatePermission(
      {
        action: "tool.call",
        inputRules: [
          {
            toolPattern: "bash",
            field: "command",
            pattern: "^sudo",
            action: "require_approval",
            reason: "destructive_command",
            priority: 5,
          },
        ],
      },
      request("bash", { command: "sudo rm -rf /" }),
    );

    expect(result).toMatchObject({
      action: "abort",
      decision: "require_approval",
      reason: "destructive_command",
      policyId: "guardrail.permission",
      matchedPattern: "bash",
    });
  });

  it("fails closed when unsafe or invalid runtime input rules reach evaluation", () => {
    for (const pattern of ["^a*a*a*$", "("]) {
      expect(
        evaluatePermission(
          {
            action: "tool.call",
            allowlist: ["*"],
            inputRules: [
              {
                toolPattern: "bash",
                field: "command",
                pattern,
                action: "allow",
                priority: 100,
              },
            ],
          },
          request("bash", { command: "aaaaab" }),
        ),
      ).toMatchObject({
        action: "abort",
        decision: "deny",
        reason: "unsafe_input_rule",
        matchedPattern: "bash",
      });
    }
  });

  it("uses highest priority matching input rule before list policies", () => {
    expect(
      evaluatePermission(
        {
          action: "tool.call",
          denylist: ["bash"],
          inputRules: [
            {
              toolPattern: "bash",
              field: "command",
              pattern: "^npm",
              action: "deny",
              priority: 1,
            },
            {
              toolPattern: "bash",
              field: "command",
              pattern: "^npm test$",
              action: "allow",
              reason: "safe command",
              priority: 10,
            },
          ],
        },
        request("bash", { command: "npm test" }),
      ),
    ).toMatchObject({
      action: "continue",
      reason: "safe command",
      policyId: "guardrail.permission",
      matchedPattern: "bash",
    });
  });
});

describe("decisionFromEvaluation", () => {
  it("maps continue to a bare allow decision", () => {
    const decision = decisionFromEvaluation(
      evaluatePermission(
        { action: "tool.call", allowlist: ["bash"] },
        {
          action: "tool.call",
          resource: "bash",
        },
      ),
    );

    expect(decision).toEqual({
      policyId: "guardrail.permission",
      verdict: "allow",
      effects: [],
      reasonCodes: ["allowlist"],
    });
  });

  it("maps abort to a deny with abort and audit effects", () => {
    const decision = decisionFromEvaluation(
      evaluatePermission(
        { action: "tool.call", denylist: ["bash"] },
        {
          action: "tool.call",
          resource: "bash",
        },
      ),
    );

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toEqual(["denylist"]);
    expect(decision.effects).toEqual([
      { type: "run.abort", reason: "denylist" },
      { type: "audit.annotate", annotation: "denylist", severity: "error" },
    ]);
  });

  it("honors a caller-supplied deny effect and policyId", () => {
    const decision = decisionFromEvaluation(
      evaluatePermission(
        { action: "tool.call", denylist: ["bash"] },
        {
          action: "tool.call",
          resource: "bash",
        },
      ),
      {
        policyId: "custom.guard",
        denyEffect: { type: "tool.skip_invocation", reason: "denylist" },
      },
    );

    expect(decision.policyId).toBe("custom.guard");
    expect(decision.effects[0]).toEqual({ type: "tool.skip_invocation", reason: "denylist" });
  });

  it("maps require_approval to a pending decision with a human-approval obligation", () => {
    const decision = decisionFromEvaluation(
      evaluatePermission(
        { action: "tool.call", requireApproval: ["bash"] },
        {
          action: "tool.call",
          resource: "bash",
        },
      ),
    );

    expect(decision.verdict).toBe("pending");
    expect(decision.effects).toEqual([
      { type: "tool.require_approval", reason: "require_approval" },
    ]);
  });
});
