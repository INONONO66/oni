import type { Ingress, SessionTransition } from "@oni/protocol";
import type { ChannelStores } from "../stores.js";
type Correlation = SessionTransition.Correlation;

/** Physical responder evidence only; kernel request transitions own admission and persistence. */

type ResponderTarget = Readonly<{
  /** Responder id credited to the fold when this target matches. */
  responderId: string;
  /** Pinned actor identity; the sender must resolve to it. */
  targetActorId: string;
  /** Expected endpoint; when present the sender must prove control of it. */
  endpointId?: string;
}>;

type SenderEvidence = Readonly<{
  /** Endpoint the sender claims via correlation (consistency-checked, not proof). */
  claimedEndpointId?: string;
  /** Resolved sender identity, when the phase could establish one. */
  actorId?: string;
  /** Phase extension: does the presented evidence prove control of the expected endpoint? */
  provesEndpoint: (expectedEndpointId: string) => boolean;
}>;

/** Request targets always pin an actor; endpoint claims are consistency checks, not proof. */
function matchesTarget(target: ResponderTarget, evidence: SenderEvidence): boolean {
  if (
    target.endpointId !== undefined &&
    evidence.claimedEndpointId !== undefined &&
    evidence.claimedEndpointId !== target.endpointId
  ) {
    return false;
  }
  if (evidence.actorId !== target.targetActorId) return false;
  return target.endpointId === undefined || evidence.provesEndpoint(target.endpointId);
}

export function responderCandidates(
  targets: readonly ResponderTarget[],
  evidence: SenderEvidence,
): string[] {
  return [
    ...new Set(
      targets.filter((target) => matchesTarget(target, evidence)).map((t) => t.responderId),
    ),
  ];
}

/** Registry-resolved actor endpoint proof. */
export function ingressEvidence(
  // Structural pick (#707 stage 2): the gateway router matches evidence on
  // the routed event BEFORE the brain-owned AgentDef exists, so the full
  // DirectEvent (which requires `agent`) is deliberately not demanded here.
  event: Pick<Ingress.InboundEvent, "meta">,
  correlation: Correlation,
): SenderEvidence {
  const actor = event.meta?.actor;
  const actorId = typeof actor?.actorId === "string" ? actor.actorId : undefined;
  return {
    claimedEndpointId: correlation.endpointId,
    ...(actorId === undefined ? {} : { actorId }),
    provesEndpoint: (expected) => {
      if (actorId !== undefined) {
        const endpoint = actor?.endpoint;
        if (endpoint === undefined) return actor?.endpointId === expected;
        return (
          endpoint.id === expected ||
          endpoint.externalId === expected ||
          `${endpoint.channel}:${endpoint.externalId}` === expected
        );
      }
      return false;
    },
  };
}

/**
 * Matcher targets for a durable request row: every expected responder is an
 * actor pin. The request's correlation.endpointId is the DELIVERY endpoint, so
 * it pins ONLY the responder who is the delivery target. `deliveryActorId`
 * is the registry-resolved actor registered at that endpoint (registry-anchored,
 * not sender-claimed — the ActorRegistry lookup happens here). Every other expected responder replies from their OWN
 * endpoint, and their identity proof is the resolved-actor evidence alone.
 * Because every target carries an actor pin, request rows never accept
 * bearer-only replies. A delivery endpoint that no longer resolves
 * (`deliveryActorId === undefined` while the endpoint pin is present) fails
 * closed: no candidates, rather than a weaker unpinned target set.
 */
export function targetsOfRequest(
  stores: ChannelStores,
  record: SessionTransition.Request,
): ResponderTarget[] {
  const deliveryEndpointId = record.correlation.endpointId;
  const deliveryActorId =
    deliveryEndpointId === undefined
      ? undefined
      : stores.actors.getEndpoint(deliveryEndpointId)?.actorId;
  if (deliveryEndpointId !== undefined && deliveryActorId === undefined) {
    return [];
  }
  return record.expectedResponders.map((responderId) => ({
    responderId,
    targetActorId: responderId,
    ...(deliveryEndpointId !== undefined && responderId === deliveryActorId
      ? { endpointId: deliveryEndpointId }
      : {}),
  }));
}
