import { type Policy, PolicyDecision } from "@oni/protocol";
import { decisionFromEvaluation, evaluatePermission } from "@oni/agent";
import type { ChannelAuthnDecisionObserver } from "./types";

export function evaluateChannelPermission(input: {
  readonly action: string;
  readonly resource: string;
  readonly field: string;
  readonly allowed: boolean;
  readonly allowReason: string;
  readonly denyReason: string;
}): Policy.PolicyDecision {
  const request = {
    action: input.action,
    resource: input.resource,
    input: { [input.field]: String(input.allowed) },
  } satisfies Policy.EvaluationRequest;

  return decisionFromEvaluation(
    evaluatePermission(
      {
        action: input.action,
        inputRules: [
          {
            toolPattern: input.resource,
            field: input.field,
            pattern: "^true$",
            action: "allow",
            reason: input.allowReason,
            priority: 2,
          },
          {
            toolPattern: input.resource,
            field: input.field,
            pattern: "^false$",
            action: "deny",
            reason: input.denyReason,
            priority: 1,
          },
        ],
      },
      request,
    ),
    { denyEffect: { type: "run.abort", reason: input.denyReason } },
  );
}

export function recordDecision(
  name: string,
  verdict: Policy.PolicyDecision,
  durationMs: number,
  onDecision: ChannelAuthnDecisionObserver | undefined,
): void | Promise<void> {
  return onDecision?.({
    timing: "run.start",
    name,
    policyId: verdict.policyId ?? "guardrail.permission",
    verdict: verdict.verdict,
    reason: PolicyDecision.reason(verdict, "unspecified"),
    durationMs,
  });
}
