import { Data } from "effect";
import type { Actor, Storage as ProtocolStorage } from "@oni/protocol";
import { requireSubAdapter, withStoreTimestamps } from "@oni/agent";
import { StoredIdentity, StoredEndpoint } from "../sqlite/actor-schema.js";

/**
 * A synchronous actor-registry write the caller can handle: an unknown
 * identity or endpoint, an already-claimed address, or a wrong standing.
 * Thrown because the registry surface is not Effect code.
 */
class ActorRegistryRefused extends Data.TaggedError("ActorRegistryRefused")<{
  readonly operation: "registerEndpoint" | "mintProvisional" | "promote" | "mergeEndpoint";
  readonly reason: "identity" | "endpoint" | "address" | "standing";
  readonly message: string;
}> {}


/** The catalog-handle slice the actor registry writes through (W5.2 F1). */
export interface ActorRegistrySource {
  readonly actorRegistry?: ProtocolStorage.ActorRegistrySubAdapter;
  /** Injected wall clock (#1245): the catalog handle carries it. */
  readonly now: () => number;
  transaction<T>(operation: () => T): T;
}

export type ActorRegistry = ReturnType<typeof createActorRegistry>;

export function createActorRegistry(source: ActorRegistrySource) {
  function requireAdapter(): ProtocolStorage.ActorRegistrySubAdapter {
    return requireSubAdapter(
      source.actorRegistry,
      "Storage adapter does not implement actorRegistry",
    );
  }

  function registerIdentity(input: Actor.Identity) {
    const adapter = requireAdapter();
    const identity = StoredIdentity.parse(
      withStoreTimestamps(input, adapter.getIdentity(input.id), source.now()),
    );
    adapter.setIdentity(identity);
    return identity;
  }

  function getIdentity(id: string) {
    return StoredIdentity.optional().parse(requireAdapter().getIdentity(id));
  }

  function registerEndpoint(input: Actor.Endpoint) {
    const adapter = requireAdapter();
    const endpoint = StoredEndpoint.parse(
      withStoreTimestamps(input, adapter.getEndpoint(input.id), source.now()),
    );
    if (!adapter.getIdentity(endpoint.actorId)) {
      throw new ActorRegistryRefused({
        operation: "registerEndpoint",
        reason: "identity",
        message: `Actor identity not found: ${endpoint.actorId}`,
      });
    }
    const existingForAddress = adapter.findEndpoint(
      endpoint.channel,
      endpoint.externalId,
      endpoint.workspace,
    );
    if (existingForAddress && existingForAddress.id !== endpoint.id) {
      throw new ActorRegistryRefused({
        operation: "registerEndpoint",
        reason: "address",
        message: `Actor endpoint already registered for ${endpoint.channel}:${endpoint.workspace ?? ""}:${endpoint.externalId}`,
      });
    }
    adapter.setEndpoint(endpoint);
    return endpoint;
  }

  return {
    /** Whether the injected store handle provides the actor registry. */
    isConfigured(): boolean {
      return source.actorRegistry !== undefined;
    },

    registerIdentity,
    getIdentity,

    removeIdentity(id: string): boolean {
      return requireAdapter().removeIdentity(id);
    },

    registerEndpoint,

    getEndpoint(id: string) {
      return StoredEndpoint.optional().parse(requireAdapter().getEndpoint(id));
    },

    listEndpoints(actorId?: string, workspace?: string) {
      return StoredEndpoint.array().parse(requireAdapter().listEndpoints(actorId, workspace));
    },

    /**
     * #P3 provisional mint (conversation-and-message-io.md §3.1): identity +
     * endpoint land in ONE transaction — a half-minted contact never exists.
     * The row carries `standing: "provisional"` and nothing else: no grants,
     * no tier escalation — the perimeter demotes its inbound to evidence_only.
     */
    mintProvisional(identity: Actor.Identity, endpoint: Omit<Actor.Endpoint, "actorId">) {
      if (identity.standing !== "provisional") {
        throw new ActorRegistryRefused({
          operation: "mintProvisional",
          reason: "standing",
          message: `Provisional mint requires standing "provisional": ${identity.id}`,
        });
      }
      return source.transaction(() => ({
        identity: registerIdentity(identity),
        endpoint: registerEndpoint({ ...endpoint, actorId: identity.id }),
      }));
    },

    /** The §8.12 mint-volume read: provisional identities minted on this channel since `since`. */
    countProvisionalMints(channel: string, workspace: string | undefined, since: number): number {
      return requireAdapter().countProvisionalSince(channel, workspace, since);
    },

    /**
     * #P3 promotion act (§3.1/§6): provisional → registered. Idempotent —
     * promoting a registered contact returns it unchanged. The Owner-approval
     * gate lives with the tool that calls this (product authority), not here.
     */
    promote(actorId: string) {
      const identity = getIdentity(actorId);
      if (!identity) {
        throw new ActorRegistryRefused({
          operation: "promote",
          reason: "identity",
          message: `Actor identity not found: ${actorId}`,
        });
      }
      if (identity.standing !== "provisional") return identity;
      return registerIdentity({ ...identity, standing: "registered" });
    },

    /**
     * #P3 endpoint merge act (§8.4): moves one endpoint onto another identity
     * — the ONLY way two channels ever fold into one contact. The
     * Owner-approval gate lives with the tool that calls this.
     */
    mergeEndpoint(endpointId: string, toActorId: string) {
      const adapter = requireAdapter();
      const endpoint = adapter.getEndpoint(endpointId);
      if (!endpoint) {
        throw new ActorRegistryRefused({
          operation: "mergeEndpoint",
          reason: "endpoint",
          message: `Actor endpoint not found: ${endpointId}`,
        });
      }
      if (!adapter.getIdentity(toActorId)) {
        throw new ActorRegistryRefused({
          operation: "mergeEndpoint",
          reason: "identity",
          message: `Actor identity not found: ${toActorId}`,
        });
      }
      return registerEndpoint({ ...endpoint, actorId: toActorId });
    },

    resolveEndpoint(channel: string, externalId: string, workspace?: string) {
      const adapter = requireAdapter();
      const endpoint = adapter.findEndpoint(channel, externalId, workspace);
      if (!endpoint) return undefined;
      const identity = adapter.getIdentity(endpoint.actorId);
      if (!identity) return undefined;
      return {
        identity: StoredIdentity.parse(identity),
        endpoint: StoredEndpoint.parse(endpoint),
      };
    },
  };
}
