import { Bundle, Core } from "@oni/agent";

/**
 * The `approval-policy` bundle (#1309): the provider of the core's
 * `ApprovalPolicyPort` seam. The values — who answers an approval, how many
 * approvals a session may hold open per window, how long an approval stays
 * open when nothing names an expiry, and the default run budget — are rows in
 * the Owner policy file (#1572, `composition/policy.ts`); composition threads
 * them into the session runtime and the executor. The core has no fallback,
 * so a manifest without this provider refuses `seam_missing` at compose
 * (`send-message` requires the seam — the tool door whose sends reach the
 * responders cascades off with the policy, never silently).
 */
export function approvalPolicyBundle(): Bundle.BundleContract<"approval-policy"> {
  return Bundle.define({
    name: "approval-policy",
    requires: [],
    provides: [Core.ApprovalPolicyPort],
  });
}
