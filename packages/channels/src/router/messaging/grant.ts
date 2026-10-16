import type { Gateway } from "@openomni/protocol";

/**
 * Existing-agent messaging grant evaluation (#215, gateway router since #707
 * stage 2). The schema vocabulary lives in protocol as the `Gateway.Send`
 * contract (stage 0, #706); grant EVALUATION is forbidden in protocol
 * (contract boundary — schemas and pure folds only, never authority
 * evaluation), so the evaluator lives here on the perimeter.
 *
 * One evaluator since #1569: the Owner-declared standing grant. The reply
 * to the conversation that prompted a turn is not a grant at all — it is
 * authorized by the router's own conversation binding (`messaging/reply.ts`),
 * so the former rule-materialized, reply-scoped instances are gone.
 */

type GrantClaim = Readonly<{
  senderId: string;
  targetActorId: string;
  operation: Gateway.MessageOperation;
  at: number;
}>;

function matchesClaim(grant: Gateway.SenderTargetGrant, claim: GrantClaim): boolean {
  return (
    grant.senderId === claim.senderId &&
    grant.targetActorId === claim.targetActorId &&
    grant.operations.includes(claim.operation) &&
    (grant.expiresAt === undefined || claim.at <= grant.expiresAt)
  );
}

function idOrdered(
  grants: readonly Gateway.SenderTargetGrant[],
): readonly Gateway.SenderTargetGrant[] {
  return [...grants].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * Pure policy-plane grant evaluation: returns the first (id-ordered) active
 * grant binding this sender to this target for this operation, or undefined —
 * the caller fails closed as `ungranted`. Time is an input; an expired grant
 * is simply not active.
 */
export function resolveSenderTargetGrant(
  grants: readonly Gateway.SenderTargetGrant[],
  claim: GrantClaim,
): Gateway.SenderTargetGrant | undefined {
  return idOrdered(grants).find((grant) => matchesClaim(grant, claim));
}
