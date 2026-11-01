import { Bundle, Core } from "@oni/agent";
import { Machine } from "@oni/protocol";
import { ToolCapabilityPort } from "../seams";

const COMPUTER_METHODS = [
  Machine.WireMethod.ClipboardRead, Machine.WireMethod.ClipboardWrite,
  Machine.WireMethod.InputPointer, Machine.WireMethod.InputKey, Machine.WireMethod.InputText,
  Machine.WireMethod.InputAction, Machine.WireMethod.ScreenObserve, Machine.WireMethod.ScreenSettle,
  Machine.WireMethod.AppLaunch, Machine.WireMethod.AppQuit, Machine.WireMethod.WindowClose, Machine.WireMethod.WindowPark,
];

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
export function approvalPolicyBundle(computer: () => { decide: Core.NamedGuard["decide"] } | undefined = () => undefined): Bundle.BundleContract<"approval-policy"> {
  return Bundle.define({
    name: "approval-policy",
    requires: [ToolCapabilityPort],
    provides: [Core.ApprovalPolicyPort],
    rows: COMPUTER_METHODS.map((op) => ({
      id: `computer-use:${op}`, on: "tool.pre", when: { op }, do: "gate",
      how: { ref: "approval-policy/computer-use" }, order: 100,
    })),
    handlers: {
      "approval-policy/computer-use": {
        decide: (input: Parameters<Core.NamedGuard["decide"]>[0]) => computer()?.decide(input) ?? { verdict: "deny", payload: { reason: "lease_missing" } },
      },
    },
  });
}
