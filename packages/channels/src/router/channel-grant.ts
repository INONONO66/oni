import type { Actor } from "@oni/protocol";
import type { ChannelStores } from "./stores.js";

interface ChannelGrantMatchInput {
  readonly surface: string;
  readonly workspace?: string;
  readonly channel?: string;
  /** The sender's external id on that surface — matched against grant allowlists. */
  readonly sender?: string;
}

export interface ChannelGrantResolution {
  readonly grant: Actor.ChannelGrant;
  readonly inboundTreatment: Actor.InboundTreatment;
}

function defaultTreatment(kind: Actor.ChannelGrantKind): Actor.InboundTreatment {
  if (kind === "trusted_channel") return "full_access";
  if (kind === "broadcast_channel") return "evidence_only";
  return "drop";
}

function matches(grant: Actor.ChannelGrant, input: ChannelGrantMatchInput): boolean {
  if (grant.surface !== input.surface) return false;
  if (grant.workspace !== undefined && grant.workspace !== input.workspace) return false;
  if (grant.channel !== undefined && grant.channel !== input.channel) return false;
  // An allowlisted grant does not exist for a stranger: resolution falls
  // through to any less restricted grant or to none (fail-closed block).
  if (
    grant.allowedSenders !== undefined &&
    (input.sender === undefined || !grant.allowedSenders.includes(input.sender))
  ) {
    return false;
  }
  return true;
}

function specificity(grant: Actor.ChannelGrant): number {
  return (grant.workspace === undefined ? 0 : 1) + (grant.channel === undefined ? 0 : 1);
}

const treatmentRestriction: Record<Actor.InboundTreatment, number> = {
  drop: 0,
  evidence_only: 1,
  full_access: 2,
};

const defaultTierRestriction: Record<Actor.TrustTier, number> = {
  assigned_worker: 1,
  observer: 2,
  collaborator: 3,
  manager: 4,
  co_owner: 5,
  owner: 6,
};

const kindRestriction: Record<Actor.ChannelGrantKind, number> = {
  blocked_channel: 0,
  broadcast_channel: 1,
  trusted_channel: 2,
};

function effectiveTreatment(grant: Actor.ChannelGrant): Actor.InboundTreatment {
  const treatment = grant.inboundTreatment ?? defaultTreatment(grant.kind);
  if (grant.kind === "blocked_channel" || treatment === "drop") return "drop";
  if (grant.kind === "broadcast_channel") return "evidence_only";
  return treatment;
}

function compareStableText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Chooses the perimeter's effective channel grant. Specificity wins first;
 * equal-score grants use a fail-closed, backend-independent total order.
 */
function compareResolutionOrder(a: Actor.ChannelGrant, b: Actor.ChannelGrant): number {
  const specificityOrder = specificity(b) - specificity(a);
  if (specificityOrder !== 0) return specificityOrder;

  const treatmentOrder =
    treatmentRestriction[effectiveTreatment(a)] - treatmentRestriction[effectiveTreatment(b)];
  if (treatmentOrder !== 0) return treatmentOrder;

  const defaultTierOrder =
    (a.defaultTier === undefined ? 0 : defaultTierRestriction[a.defaultTier]) -
    (b.defaultTier === undefined ? 0 : defaultTierRestriction[b.defaultTier]);
  if (defaultTierOrder !== 0) return defaultTierOrder;

  const kindOrder = kindRestriction[a.kind] - kindRestriction[b.kind];
  if (kindOrder !== 0) return kindOrder;

  return compareStableText(a.id, b.id);
}

export function resolveChannelGrant(
  stores: ChannelStores,
  input: ChannelGrantMatchInput,
): ChannelGrantResolution | undefined {
  const grants = stores.channelGrants.list().filter((grant) => matches(grant, input));
  grants.sort(compareResolutionOrder);
  const grant = grants[0];
  if (grant === undefined) return undefined;
  return {
    grant,
    inboundTreatment: effectiveTreatment(grant),
  };
}

/**
 * The authority a `ws` sender carries on this perimeter: its registered
 * identity's tier, else the tier the surface's bootstrap grant materializes
 * (the loopback/token-gated owner grant the app registers). Chat admits the
 * Owner through exactly this fact; the app's automation callback reads the
 * same one, so there is one rule for who the Owner's own connection is.
 */
export function webSocketSenderTier(
  stores: ChannelStores,
  externalId: string,
): Actor.TrustTier | undefined {
  return (
    stores.actors.resolveEndpoint("ws", externalId)?.identity.trustTier ??
    resolveChannelGrant(stores, { surface: "ws", sender: externalId })?.grant.defaultTier
  );
}
