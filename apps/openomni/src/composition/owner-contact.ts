import type { ChannelDeliveryRoute } from "@openomni/channels";
import type { Provisioning } from "@openomni/protocol";

/** Where a drafted answer goes (#1600 lane R2): the Owner Person on a platform the bot can write to — the resident bundle's `ownerContact` shape. */
interface OwnerContact {
  readonly actorId: string;
  readonly surface: string;
}

/**
 * The Owner's contact for a draft (#1600 lane R2): the owner-tier Person's
 * first endpoint on a platform where the bot writes a person cold — a
 * messenger bot route, or the loopback socket (GitHub, a webhook target and
 * the Owner-only platforms address no person) — and where the Owner holds
 * one endpoint, since the actor target names a surface and two endpoints
 * on it are ambiguous; a live platform before `ws`, which needs an open
 * socket. Absent, the draft is the Owner's to read in the session; the
 * gateway's draft observation already names it.
 */
export function ownerContactFor(
  persons: readonly Provisioning.Person[],
  routes: ReadonlyMap<string, ChannelDeliveryRoute>,
): OwnerContact | undefined {
  const owner = persons.find((person) => person.trustTier === "owner");
  if (owner === undefined) return undefined;
  const held = new Map<string, number>();
  for (const endpoint of owner.endpoints) held.set(endpoint.channel, (held.get(endpoint.channel) ?? 0) + 1);
  const reachable = owner.endpoints.filter(
    (endpoint) =>
      held.get(endpoint.channel) === 1 &&
      (routes.has(`${endpoint.channel}:bot`) || (endpoint.channel === "ws" && routes.has("ws"))),
  );
  const endpoint = reachable.find((candidate) => candidate.channel !== "ws") ?? reachable[0];
  return endpoint === undefined ? undefined : { actorId: owner.id, surface: endpoint.channel };
}
