import { Bundle, Core } from "@openomni/agent";

/**
 * The `approval-policy` bundle (#1309): the executable product decisions the
 * core used to hard-code, owned here as plain data behind the core's
 * `ApprovalPolicyPort` — who answers an approval, how many approvals a
 * session may hold open per window, how long an approval stays open when
 * nothing names an expiry, and the default run budget. Composition threads
 * `APPROVAL_POLICY` into the session runtime and the executor; the core has
 * no fallback, so a manifest without this provider refuses `seam_missing`
 * at compose (`send-message` requires the seam — the tool door whose sends
 * reach the responders cascades off with the policy, never silently).
 */
export const APPROVAL_POLICY: Core.ApprovalPolicy = Object.freeze({
  /** Every approval request addresses the session owner. */
  responders: Object.freeze(["owner"]),
  /** At most 8 open approvals per rolling hour. */
  recentOpen: Object.freeze({ limit: 8, windowMs: 3_600_000 }),
  /** An approval with no binding/executor expiry stays open 24 hours. */
  defaultExpiryMs: 86_400_000,
  /** The run budget a run with no explicit budget resolves against. */
  defaultBudget: Object.freeze({
    maxTurns: 24,
    maxToolCalls: 40,
    maxWallTimeMs: 5 * 60 * 1000,
    maxToolRuntimeMs: 2 * 60 * 1000,
  }),
});

/** The provider contract: zero rows, zero faces — the bundle owns values. */
export function approvalPolicyBundle(): Bundle.BundleContract<"approval-policy"> {
  return Bundle.define({
    name: "approval-policy",
    requires: [],
    provides: [Core.ApprovalPolicyPort],
  });
}
