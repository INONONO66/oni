import type { Actor, Gateway } from "@oni/protocol";
import type { ChannelStores } from "./stores.js";

function externalActorId(event: Gateway.DeliveredEvent): string | undefined {
  return event.userId;
}

function resolvedActorEvent(
  event: Gateway.DeliveredEvent,
  resolved: Actor.ResolvedEndpoint,
): Gateway.DeliveredEvent {
  const provisional = resolved.identity.standing === "provisional";
  return {
    ...event,
    // A provisional contact's inbound is evidence to read about, never a
    // command to act on (§8.12): the marker rides the existing monotonic
    // treatment floor — channel admission can only keep it, never raise it.
    meta: {
      ...event.meta,
      ...(provisional ? { inboundTreatment: "evidence_only" as const } : {}),
      actor: {
        id: resolved.endpoint.externalId,
        role: "user",
        actorId: resolved.identity.id,
        kind: resolved.identity.kind,
        trustTier: resolved.identity.trustTier,
        ...(resolved.identity.standing === undefined
          ? {}
          : { standing: resolved.identity.standing }),
        endpointId: resolved.endpoint.id,
        endpoint: resolved.endpoint,
      },
    },
  };
}

export function resolveIngressActor(
  stores: ChannelStores,
  event: Gateway.DeliveredEvent,
): Gateway.DeliveredEvent {
  const externalId = externalActorId(event);
  // Identity provenance is the authenticated sender, never inbound meta.actor.
  const projected: Gateway.DeliveredEvent = {
    ...event,
    meta: { ...event.meta, actor: { ...(externalId ? { id: externalId } : {}), role: "user" } },
  };
  if (!externalId || !stores.actors.isConfigured()) return projected;

  const resolved =
    stores.actors.resolveEndpoint(event.surface, externalId, event.workspace);
  if (!resolved) return projected;

  return resolvedActorEvent(event, resolved);
}
