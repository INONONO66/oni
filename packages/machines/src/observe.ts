import type { Machine } from "@oni/protocol";

export function observeRefusal(grant: "permission_denied" | "not_available"): Machine.ScreenObserveResult {
  return { status: "refused", reason: grant === "permission_denied" ? grant : "observe_not_available" };
}
