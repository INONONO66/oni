import type { ApprovalPolicy } from "../../src/core/approval-policy";
import type { AgentBudget, ResolvedAgentBudget } from "../../src/core/types";

/**
 * The fixture run budget: the values the core used to
 * hard-code as its default budget, now stated explicitly where tests need a resolved budget.
 */
export const TEST_BUDGET: ResolvedAgentBudget = {
  maxTurns: 24,
  maxToolCalls: 40,
  maxWallTimeMs: 5 * 60 * 1000,
  maxToolRuntimeMs: 2 * 60 * 1000,
};

/** A resolved budget with per-field overrides, for budget-enforcement tests. */
export function testBudget(overrides?: AgentBudget): ResolvedAgentBudget {
  return { ...TEST_BUDGET, ...overrides };
}

/**
 * The fixture approval policy: the shipped product values the core
 * used to hard-code (owner responder, 8 open approvals per hour, 24h expiry).
 * Production reads these from `apps/openomni/src/bundles/approval-policy`.
 */
export const TEST_APPROVAL_POLICY: ApprovalPolicy = {
  responders: ["owner"],
  recentOpen: { limit: 8, windowMs: 3_600_000 },
  defaultExpiryMs: 86_400_000,
  defaultBudget: TEST_BUDGET,
};
