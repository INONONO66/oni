import { type Policy, PolicyDecision } from "@oni/protocol";
import type { ChannelAuthnDecisionObserver } from "./types";

const POLICY_ID = "guardrail.permission";

export function evaluateChannelPermission(input: {
  readonly allowed: boolean;
  readonly allowReason: string;
  readonly denyReason: string;
}): Policy.PolicyDecision {
  if (input.allowed) {
    return PolicyDecision.allow({ policyId: POLICY_ID, reasonCodes: [input.allowReason] });
  }
  return PolicyDecision.deny({
    policyId: POLICY_ID,
    reasonCodes: [input.denyReason],
    effects: [
      { type: "run.abort", reason: input.denyReason },
      { type: "audit.annotate", annotation: input.denyReason, severity: "error" },
    ],
  });
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
    policyId: verdict.policyId,
    verdict: verdict.verdict,
    reason: PolicyDecision.reason(verdict),
    durationMs,
  });
}
