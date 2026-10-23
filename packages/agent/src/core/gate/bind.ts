import { PolicyDecision, PolicyPermission, type Policy, type LedgerSession, type AnyToolDefinition, type PointRecord } from "@oni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { evaluate } from "./evaluate";
import type { CompiledPolicySnapshot, GateHandlerResult, GatePointTable, PolicyBinding, PolicyEvaluation, PolicyEvaluationInput } from "./types";

/** Bind one immutable generation to the loop's synchronous replay and ordered consultation. */
export function bind(snapshot: CompiledPolicySnapshot): PolicyBinding {
  const evaluateEffect = (input: PolicyEvaluationInput): Effect.Effect<PolicyEvaluation> => Effect.suspend(() => {
    if (snapshot.consultants.size === 0) return Effect.sync(() => evaluate(snapshot, input));
    const pendingAsync = new Set(snapshot.consultants.keys());
    const prepared = new Map<string, GateHandlerResult>();
    const step: Effect.Effect<PolicyEvaluation> = Effect.suspend(() => {
      const pending = evaluate(snapshot, input, { pendingAsync, prepared }).pending;
      if (pending === undefined) return Effect.sync(() => evaluate(snapshot, input, { prepared }));
      const consultant = snapshot.consultants.get(pending.ref);
      if (consultant === undefined) return Effect.die(`unregistered consultant ${pending.ref}`);
      return consultant.consult({
        rowId: pending.rowId, point: pending.point, params: pending.params, value: pending.value,
      }).pipe(Effect.flatMap((result) => {
        prepared.set(pending.rowId, result);
        return step;
      }));
    });
    return step;
  });
  return Object.freeze({ generation: snapshot.generation, contentHash: snapshot.contentHash,
    pointTable: snapshot.pointTable, evaluate: (input: PolicyEvaluationInput) => evaluate(snapshot, input), evaluateEffect });
}

export function executionPoint(kind: string, phase: "pre" | "post", table: GatePointTable): PointRecord | undefined {
  return table.get(`${kind}.${phase}`);
}

/** Even injected bindings cannot admit an operation on an unregistered execution point. */
export function admit(policy: PolicyBinding, input: PolicyEvaluationInput): Effect.Effect<PolicyEvaluation> {
  const result = policy.evaluateEffect === undefined ? Effect.sync(() => policy.evaluate(input)) : policy.evaluateEffect(input);
  return result.pipe(Effect.map((decision) => executionPoint(input.kind, input.phase, policy.pointTable) === undefined
    ? { ...decision, verdict: "deny" as const, reason: "unknown_point" } : decision));
}

/** A captured generation exposes only its offered tools with a door for the session's role. */
export function filterLoadout<T extends Pick<AnyToolDefinition, "name" | "visibility">>(
  definitions: readonly T[], offered: ReadonlySet<string>, role: LedgerSession.Role,
): readonly T[] {
  return Object.freeze(definitions.filter((tool) => offered.has(tool.name)
    && (tool.visibility.model.includes(role) || tool.visibility.cell.includes(role))));
}

const POLICY_ID = "guardrail.permission";
const PolicyInput = z.record(z.string(), z.json());
type PolicyInput = z.infer<typeof PolicyInput>;

type PermissionDecision = NonNullable<Policy.EvaluationResult["decision"]>;

function matchesPattern(resource: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return resource.startsWith(`${pattern.slice(0, -2)}.`);
  return resource === pattern;
}

function findMatchingLabel(
  labels: readonly string[] | undefined,
  patterns: readonly string[] | undefined,
): string | undefined {
  if (!patterns || patterns.length === 0) return undefined;
  for (const pattern of patterns) {
    if (labels?.some((label) => matchesPattern(label, pattern))) return pattern;
  }
  return undefined;
}

type InputMatchResult = "match" | "miss" | "unsafe";

function matchesInputField(
  input: PolicyInput | undefined,
  field: string,
  pattern: string,
): InputMatchResult {
  if (!PolicyPermission.isSafeInputPattern(pattern)) return "unsafe";

  const raw = String(input?.[field] ?? "");
  const value =
    raw.length > PolicyPermission.MAX_INPUT_LENGTH
      ? raw.slice(0, PolicyPermission.MAX_INPUT_LENGTH)
      : raw;

  return new RegExp(pattern).test(value) ? "match" : "miss";
}

function verdict(
  decision: PermissionDecision,
  reason: string,
  matchedPattern?: string,
): Policy.EvaluationResult {
  const action: Policy.EvaluationResult["action"] = decision === "allow" ? "continue" : "abort";
  return matchedPattern === undefined
    ? { action, decision, reason, policyId: POLICY_ID }
    : { action, decision, reason, policyId: POLICY_ID, matchedPattern };
}

function evaluateInputRules(
  permission: Policy.Permission,
  request: Policy.EvaluationRequest,
): Policy.EvaluationResult | undefined {
  const inputRules = [...(permission.inputRules ?? [])].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );

  const parsedInput = PolicyInput.safeParse(request.input);
  if (!parsedInput.success && request.input !== undefined) {
    return verdict("deny", "unsafe_input_rule");
  }

  for (const rule of inputRules) {
    if (!matchesPattern(request.resource, rule.toolPattern)) continue;

    const inputMatch = matchesInputField(parsedInput.success ? parsedInput.data : undefined, rule.field, rule.pattern);
    if (inputMatch === "unsafe") {
      return verdict("deny", "unsafe_input_rule", rule.toolPattern);
    }
    if (inputMatch === "match")
      return verdict(rule.action, rule.reason ?? `input_rule_${rule.action}`, rule.toolPattern);
  }

  return undefined;
}

function evaluateResourceRestrictions(
  permission: Policy.Permission,
  request: Policy.EvaluationRequest,
): Policy.EvaluationResult | undefined {
  const deniedBy = permission.denylist?.find((pattern) =>
    matchesPattern(request.resource, pattern),
  );
  if (deniedBy) return verdict("deny", "denylist", deniedBy);

  const deniedByLabel = findMatchingLabel(request.resourceLabels, permission.denyLabels);
  if (deniedByLabel) return verdict("deny", "deny_label", deniedByLabel);

  const requiresApprovalBy = permission.requireApproval?.find((pattern) =>
    matchesPattern(request.resource, pattern),
  );
  if (requiresApprovalBy) {
    return verdict("require_approval", "require_approval", requiresApprovalBy);
  }

  const requiresApprovalByLabel = findMatchingLabel(
    request.resourceLabels,
    permission.requireApprovalLabels,
  );
  if (requiresApprovalByLabel) {
    return verdict("require_approval", "require_approval_label", requiresApprovalByLabel);
  }

  return undefined;
}

function evaluateAllowConstraints(
  permission: Policy.Permission,
  request: Policy.EvaluationRequest,
): Policy.EvaluationResult | undefined {
  if (permission.allowlist !== undefined) {
    const allowedBy = permission.allowlist.find((pattern) =>
      matchesPattern(request.resource, pattern),
    );

    if (allowedBy) return verdict("allow", "allowlist", allowedBy);

    const reason = permission.allowlist.length === 0 ? "allowlist_empty" : "allowlist_miss";
    return verdict("deny", reason);
  }

  if (permission.allowLabels !== undefined) {
    const allowedByLabel = findMatchingLabel(request.resourceLabels, permission.allowLabels);
    if (allowedByLabel) return verdict("allow", "allow_label", allowedByLabel);
    const reason = permission.allowLabels.length === 0 ? "allow_labels_empty" : "allow_labels_miss";
    return verdict("deny", reason);
  }

  return undefined;
}

export function evaluatePermission(
  permission: Policy.Permission | undefined,
  request: Policy.EvaluationRequest,
): Policy.EvaluationResult {
  if (!permission) return verdict("deny", `default_deny:${request.action}`);
  if (permission.action !== request.action) return verdict("deny", "action_mismatch");

  const inputRuleResult = evaluateInputRules(permission, request);
  if (inputRuleResult) return inputRuleResult;

  const restrictionResult = evaluateResourceRestrictions(permission, request);
  if (restrictionResult) return restrictionResult;

  const allowResult = evaluateAllowConstraints(permission, request);
  if (allowResult) return allowResult;

  return verdict("deny", `default_deny:${request.action}`);
}

export function decisionFromEvaluation(
  result: Policy.EvaluationResult,
  options: {
    readonly policyId?: string;
    readonly denyEffect?: Policy.PolicyEffect;
  } = {},
): Policy.PolicyDecision {
  const policyId = options.policyId ?? result.policyId;
  const reasonCodes = [result.reason];
  if (result.decision === "require_approval") {
    return PolicyDecision.pending({
      policyId,
      reasonCodes,
      effects: [{ type: "tool.require_approval", reason: result.reason }],
    });
  }

  if (result.action === "continue") return PolicyDecision.allow({ policyId, reasonCodes });

  return PolicyDecision.deny({
    policyId,
    reasonCodes,
    effects: [
      options.denyEffect ?? { type: "run.abort", reason: result.reason },
      { type: "audit.annotate", annotation: result.reason, severity: "error" },
    ],
  });
}
