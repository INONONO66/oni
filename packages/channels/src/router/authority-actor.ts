import { Actor, type Ingress, resolveTarget, type Gateway } from "@oni/protocol";

type ActorRecord = Pick<Ingress.Actor, "trustTier" | "role">;

const topLevelTrustTiers = new Set<Actor.TrustTier>(["owner", "co_owner", "manager"]);
const evidenceOnlyTrustTiers = new Set<Actor.TrustTier>(["collaborator", "observer"]);

export function getActor(event: Gateway.DeliveredEvent): ActorRecord | undefined {
  // event.meta.actor is the typed Ingress.Actor (declared field), so this is
  // typed field access — no untyped record narrowing.
  return event.meta?.actor;
}

export function actorTrustTier(actor: ActorRecord | undefined): Actor.TrustTier | undefined {
  const parsed = Actor.TrustTier.safeParse(actor?.trustTier);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Top-level inbound authorization is a pure trust-tier check. Every event that
 * reaches the routed pre-run on a routed outcome carries a resolved trustTier
 * (registry-resolved actor tier or channel-grant defaultTier materialization);
 * an untiered actor blocks at actor_identity / channel_ceiling before routing
 * ever admits it here, so the pre-split role fallbacks were unreachable and are
 * gone. An untiered actor here fails closed.
 */
export function isAuthorizedTopLevelActor(event: Gateway.DeliveredEvent): boolean {
  const actor = getActor(event);
  if (!actor) return false;

  const trustTier = actorTrustTier(actor);
  if (!trustTier) return false;
  if (topLevelTrustTiers.has(trustTier)) return true;
  return (
    resolveTarget(event).kind === "resident" &&
    event.meta?.inboundTreatment === "evidence_only" &&
    evidenceOnlyTrustTiers.has(trustTier)
  );
}
