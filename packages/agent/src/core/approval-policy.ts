import { seam, type SeamTag } from "./capability";
import type { ResolvedAgentBudget } from "./types";

/** Plain data only, no callbacks; the providing bundle owns the literals and the core has no fallback — a manifest without a provider refuses `seam_missing` at compose. */
export interface ApprovalPolicy {
  readonly responders: readonly string[];
  /** At most `limit` open approvals per `windowMs`. */
  readonly recentOpen: ApprovalRecentOpen;
  /** Applies when neither the binding nor the executor options name one. */
  readonly defaultExpiryMs: number;
  readonly defaultBudget: ResolvedAgentBudget;
}

export interface ApprovalRecentOpen {
  readonly limit: number;
  readonly windowMs: number;
}

export const ApprovalPolicySeam: SeamTag = seam("@openomni/approval/ApprovalPolicy");
