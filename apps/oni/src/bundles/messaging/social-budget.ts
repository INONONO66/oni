import type { Gateway } from "@oni/protocol";

/**
 * Active-egress budget evaluation (#219, gateway router perimeter). A PURE fold
 * — no store, no clock: time (`claim.at`) and the debit state are inputs, so
 * the decision is fully replayable and testable. Evaluation (a suppress/allow
 * ruling) lives here on the perimeter, never in protocol, exactly like grant
 * evaluation (the contract boundary forbids authority evaluation in protocol).
 *
 * The gate is the HOW-OFTEN axis; authority (MAY-I, the SenderTargetGrant) is
 * evaluated FIRST by the send kernel. The kernel only calls this for a
 * COLD-PROACTIVE send — a reply-scoped grant instance bypasses the gate
 * entirely upstream, so replies are never throttled.
 *
 * Fail-safe default (critical): `budget === undefined` means the target has NO
 * Owner-declared budget, so cold proactive outreach is capped at ZERO —
 * suppressed `budget_exhausted`, never unlimited. The send kernel reaches
 * this fold only with a budget in hand (#1569 lane 8: a target without one
 * takes the Owner's consent on the invocation, denied `approval_required`
 * otherwise); the undefined arm stays as the fold's own floor.
 */

type Suppression = Readonly<{ suppress: Gateway.MessageDenialCode }>;
type SocialBudgetVerdict = "allow" | Suppression;

const MINUTES_PER_DAY = 24 * 60;

/** UTC minute-of-day for an epoch-ms instant (pure). */
function minuteOfDayUtc(at: number): number {
  return Math.floor(at / 60_000) % MINUTES_PER_DAY;
}

/**
 * Daily quiet-hours blackout, UTC minute-of-day. A window where start <= end is
 * same-day [start, end); start > end wraps past midnight (an overnight
 * blackout). Endpoints are half-open so a 0..0 window blacks out nothing.
 */
function withinQuietHours(
  at: number,
  quietHours: NonNullable<Gateway.SocialBudget["quietHours"]>,
): boolean {
  const minute = minuteOfDayUtc(at);
  const { startMinuteUtc: start, endMinuteUtc: end } = quietHours;
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/**
 * Fold one cold-proactive claim against the target's budget and debit state.
 * Order mirrors severity: do-not-contact (hard) → lapsed allowance → quiet
 * hours → cooldown → window cap → class cap. Any miss is `allow`.
 */
export function evaluateSocialBudget(
  budget: Gateway.SocialBudget | undefined,
  state: Gateway.EgressDebitState,
  claim: Readonly<{ class: Gateway.MessageClass; at: number }>,
): SocialBudgetVerdict {
  // Fail-safe: no Owner-declared budget → cold proactive is capped at zero.
  if (budget === undefined) return { suppress: "budget_exhausted" };
  if (budget.doNotContact === true) return { suppress: "dnc_denied" };
  // A lapsed allowance re-applies the fail-safe default rather than admitting.
  if (budget.expiresAt !== undefined && claim.at > budget.expiresAt) {
    return { suppress: "budget_exhausted" };
  }
  if (budget.quietHours !== undefined && withinQuietHours(claim.at, budget.quietHours)) {
    return { suppress: "cooldown_suppressed" };
  }
  if (
    state.lastSendAt !== undefined &&
    budget.cooldownMs > 0 &&
    claim.at - state.lastSendAt < budget.cooldownMs
  ) {
    return { suppress: "cooldown_suppressed" };
  }
  if (state.countInWindow >= budget.maxPerWindow) {
    return { suppress: "budget_exhausted" };
  }
  const classCap = budget.classCaps?.[claim.class];
  if (classCap !== undefined) {
    const classCount = claim.class === "notify" ? state.notifyInWindow : state.converseInWindow;
    if (classCount >= classCap) return { suppress: "budget_exhausted" };
  }
  return "allow";
}
