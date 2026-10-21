import type { Actor, Gateway, LedgerSession, PlainValue, Policy } from "@oni/protocol";
import { PolicyDecision, PolicyPermission } from "@oni/protocol";
import { z } from "zod";


/** Authenticated projections supplied by the gateway's execution owner. */
export type MessagePolicyContext =
  | {
      readonly sender: "external";
      readonly senderTier?: Actor.TrustTier;
      readonly addressee: "bot" | "owner" | "ambient";
      readonly identity: boolean;
      readonly grantTier: boolean;
      readonly egressBudget: boolean;
      readonly eventIdUnique: boolean;
      readonly replyCorrelation: boolean;
    }
  | {
      readonly sender: "session";
      readonly senderRole: LedgerSession.Role;
      readonly targetKind: Gateway.SendMessage["to"]["kind"];
      readonly targetRole?: LedgerSession.Role;
      readonly type: Gateway.SendMessage["type"];
      readonly parentChild: boolean;
      readonly fanout: number;
      readonly depth: number;
      readonly withinParentDeadline: boolean;
      readonly actorSendAllowed?: boolean;
      /** The sending identity is granted (the Owner's account only on an Owner-origin turn through an outbound-granted instance). */
      readonly identityGranted?: boolean;
      /** The reply door may answer on its own (a bot instance, or an auto-replying Owner instance). */
      readonly replyAutoAllowed?: boolean;
      readonly consentGranted?: boolean;
    };

export function matchesMessage(
  rule: Gateway.RuleTableA | Gateway.RuleTableB,
  context: MessagePolicyContext | undefined,
): boolean {
  if (context === undefined) return false;
  switch (rule.table) {
    case "A": return matchesExternal(rule, context);
    case "B": return matchesSession(rule, context);
  }
}

function matchesExternal(
  rule: Gateway.RuleTableA,
  context: MessagePolicyContext,
): boolean {
  if (context.sender !== "external") return false;
  if (rule.senderTier !== undefined && rule.senderTier !== context.senderTier) return false;
  if (rule.addressee !== undefined && rule.addressee !== context.addressee) return false;
  const checks = {
    identity: context.identity,
    grant_tier: context.grantTier,
    egress_budget: context.egressBudget,
    event_id_dedupe: context.eventIdUnique,
    reply_correlation: context.replyCorrelation,
  };
  return checks[rule.check] === (rule.effect === "allow");
}

function matchesSession(
  rule: Gateway.RuleTableB,
  context: MessagePolicyContext,
): boolean {
  if (context.sender !== "session" || rule.senderRole !== context.senderRole) return false;
  if (rule.targetKind !== undefined && rule.targetKind !== context.targetKind) return false;
  if (rule.targetRole !== undefined && rule.targetRole !== context.targetRole) return false;
  if (rule.type !== undefined && rule.type !== context.type) return false;
  if (rule.check.kind === "type") return true;
  return sessionCheck(rule.check, context) === (rule.effect === "allow");
}

function sessionCheck(
  check: Exclude<Gateway.RuleTableB["check"], { kind: "type" }>,
  context: Extract<MessagePolicyContext, { sender: "session" }>,
): boolean {
  switch (check.kind) {
    case "parent_child": return context.parentChild;
    case "fanout": return context.fanout < check.max;
    case "depth": return context.depth <= check.max;
    case "deadline": return context.withinParentDeadline;
    case "actor_send": return context.actorSendAllowed === true;
    case "identity": return context.identityGranted === true;
    case "reply_auto": return context.replyAutoAllowed === true;
    case "consent": return context.consentGranted === true;
  }
}


export function clonePlain(value: PlainValue): PlainValue {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePlain(item)]));
}

export function freezePlain(value: PlainValue): PlainValue {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezePlain(item);
    Object.freeze(value);
  }
  return value;
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
