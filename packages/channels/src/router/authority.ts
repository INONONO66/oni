import type { Actor, Gateway } from "@oni/protocol";

import { actorTrustTier, getActor } from "./authority-actor";
import { effectiveTrustTier } from "./effective-tier.js";

/** Project the resolved channel ceiling; message pre-policy owns admission. */
export function applyChannelGrantTreatment(
  event: Gateway.DeliveredEvent,
  grant: Actor.ChannelGrant,
  inboundTreatment: Actor.InboundTreatment,
): Gateway.DeliveredEvent {
  const actor = getActor(event);
  const actorTier = actorTrustTier(actor);
  const effectiveTier = effectiveTrustTier(actorTier, grant.defaultTier);
  const actorWithChannelDefault =
    !actorTier && grant.defaultTier
      ? { ...(actor ?? { role: "user" }), trustTier: effectiveTier }
      : actor;
  return {
    ...event,
    meta: {
      ...event.meta,
      ...(actorWithChannelDefault ? { actor: actorWithChannelDefault } : {}),
      channelGrantId: grant.id,
      channelGrantKind: grant.kind,
      inboundTreatment,
    },
  };
}
