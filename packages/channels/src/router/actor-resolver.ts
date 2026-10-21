import type { Actor, Gateway } from "@oni/protocol";
import type { ChannelStores } from "./stores.js";
import { matchBlacklist } from "./blacklist.js";
import { resolveChannelGrant } from "./channel-grant.js";

function externalActorId(event: Gateway.DeliveredEvent): string | undefined {
  return event.userId;
}

function mintScopeKey(event: Gateway.DeliveredEvent, externalId: string): string {
  return [
    event.surface,
    ...(event.workspace === undefined ? [] : [event.workspace]),
    externalId,
  ].join(":");
}

/**
 * #P3 provisional mint (conversation-and-message-io.md §3.1/§8.12): an
 * unknown sender on a trusted channel with an Owner-declared mint policy
 * becomes a durable provisional contact — evidence to attach observations
 * to, never authority. Fail-closed guards, in order: the channel must be a
 * trusted_channel carrying BOTH `provisionalMint` and a `defaultTier`
 * (zero-default: no policy, no mint), the sender's address must not be
 * blacklisted, and the rolling per-channel mint window must have room. The
 * mint is one transaction (identity + endpoint), so redelivery resolves the
 * SAME contact and the route replay stays equivalent.
 */
function mintProvisionalContact(
  stores: ChannelStores,
  event: Gateway.DeliveredEvent,
  externalId: string,
  now: number,
): Actor.ResolvedEndpoint | undefined {
  // The allowlist gates minting too: a stranger gets no grant, so no contact
  // is minted for them either.
  const resolution = resolveChannelGrant(stores, {
    surface: event.surface,
    workspace: event.workspace,
    channel: event.channel,
    sender: externalId,
  });
  if (resolution === undefined || resolution.grant.kind !== "trusted_channel") return undefined;
  const policy = resolution.grant.provisionalMint;
  const tier = resolution.grant.defaultTier;
  if (policy === undefined || tier === undefined) return undefined;
  const blacklisted = matchBlacklist(
    stores,
    {
      channel: event.surface,
      candidates: [
        event.surface,
        ...(event.channel === undefined ? [] : [event.channel]),
        `${event.surface}:${event.workspace ?? ""}:${event.channel ?? ""}`,
      ],
    },
    now,
  );
  if (blacklisted !== undefined) return undefined;
  const minted = stores.actors.countProvisionalMints(
    event.surface,
    event.workspace,
    now - policy.windowMs,
  );
  if (minted >= policy.max) return undefined;
  const scope = mintScopeKey(event, externalId);
  return stores.actors.mintProvisional(
    {
      id: `contact:${scope}`,
      // Honest provenance: the perimeter knows the address, not who is behind it.
      kind: "unknown",
      trustTier: tier,
      standing: "provisional",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `ep:${scope}`,
      channel: event.surface,
      externalId,
      ...(event.workspace === undefined ? {} : { workspace: event.workspace }),
      createdAt: now,
      updatedAt: now,
    },
  );
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
  now: number,
): Gateway.DeliveredEvent {
  const externalId = externalActorId(event);
  // Identity provenance is the authenticated sender, never inbound meta.actor.
  const projected: Gateway.DeliveredEvent = {
    ...event,
    meta: { ...event.meta, actor: { ...(externalId ? { id: externalId } : {}), role: "user" } },
  };
  if (!externalId || !stores.actors.isConfigured()) return projected;

  const resolved =
    stores.actors.resolveEndpoint(event.surface, externalId, event.workspace) ??
    mintProvisionalContact(stores, event, externalId, now);
  if (!resolved) return projected;

  return resolvedActorEvent(event, resolved);
}
