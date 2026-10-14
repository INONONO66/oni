import type { Actor, Gateway } from "@openomni/protocol";
import type { ChannelStores } from "../stores.js";
import {
  deliverySurfaceKey,
  hasScopedSenderTargetCandidate,
  resolveScopedSenderTargetGrant,
  resolveSenderTargetGrant,
} from "./grant";

type TargetDenialCode = Extract<
  Gateway.MessageDenialCode,
  "target_missing" | "target_stale" | "target_ambiguous"
>;
type TargetResolution =
  | Readonly<{ ok: true; target: Gateway.DeliveryTarget }>
  | Readonly<{ ok: false; code: TargetDenialCode; reason: string }>;

function deliveryTarget(actorId: string, endpoint: Actor.Endpoint): Gateway.DeliveryTarget {
  return {
    actorId,
    endpointId: endpoint.id,
    channel: endpoint.channel,
    externalId: endpoint.externalId,
  };
}

function resolveExistingTarget(
  stores: ChannelStores,
  target: Gateway.MessageTarget,
): TargetResolution {
  const identity = stores.actors.getIdentity(target.actorId);
  if (identity === undefined) {
    return {
      ok: false,
      code: "target_missing",
      reason: `actor ${target.actorId} is not a registered identity`,
    };
  }
  if (target.endpointId !== undefined) {
    const endpoint = stores.actors.getEndpoint(target.endpointId);
    if (endpoint === undefined) {
      return {
        ok: false,
        code: "target_stale",
        reason: `pinned endpoint ${target.endpointId} no longer exists`,
      };
    }
    if (endpoint.actorId !== target.actorId) {
      return {
        ok: false,
        code: "target_stale",
        reason: `pinned endpoint ${target.endpointId} no longer belongs to ${target.actorId}`,
      };
    }
    return { ok: true, target: deliveryTarget(target.actorId, endpoint) };
  }
  // A surface hint narrows to that channel's endpoints before the
  // one-or-ambiguous rule (#1485): a person on several channels is reached
  // on the one named, without the caller knowing endpoint ids.
  const endpoints = stores.actors
    .listEndpoints(target.actorId)
    .filter((candidate) => target.surface === undefined || candidate.channel === target.surface);
  const where = target.surface === undefined ? "" : ` on ${target.surface}`;
  const [endpoint, ...rest] = endpoints;
  if (endpoint === undefined) {
    return {
      ok: false,
      code: "target_stale",
      reason: `actor ${target.actorId} has no allocated endpoint${where}`,
    };
  }
  if (rest.length > 0) {
    return {
      ok: false,
      code: "target_ambiguous",
      reason: `actor ${target.actorId} is reachable at ${endpoints.length} endpoints${where} — pin target.endpointId`,
    };
  }
  return { ok: true, target: deliveryTarget(target.actorId, endpoint) };
}

/** Grant admission precedes registry access, so ungranted senders learn no target facts. */
export function authorizeSend(
  stores: ChannelStores,
  input: Pick<Gateway.SendInput, "senderId" | "target" | "operation" | "at">,
  grants: readonly Gateway.SenderTargetGrant[],
):
  | {
      readonly ok: true;
      readonly target: Gateway.DeliveryTarget;
      readonly grant: Gateway.SenderTargetGrant;
    }
  | { readonly ok: false; readonly code: Gateway.MessageDenialCode; readonly reason: string } {
  const claim = {
    senderId: input.senderId,
    targetActorId: input.target.actorId,
    operation: input.operation,
    at: input.at,
  };
  const grant = resolveSenderTargetGrant(grants, claim);
  if (grant === undefined && !hasScopedSenderTargetCandidate(grants, claim)) {
    return {
      ok: false,
      code: "ungranted",
      reason: `no active sender-target grant covers ${input.senderId} -> ${input.target.actorId} (${input.operation})`,
    };
  }
  const resolution = resolveExistingTarget(stores, input.target);
  if (!resolution.ok) return resolution;
  if (grant === undefined) {
    const surfaceKey = deliverySurfaceKey(resolution.target);
    const scopedGrant = resolveScopedSenderTargetGrant(grants, { ...claim, surfaceKey });
    if (scopedGrant === undefined) {
      return {
        ok: false,
        code: "ungranted",
        reason: `reply-scoped grant does not cover surface ${surfaceKey} — replies stay inside the initiating container`,
      };
    }
    return { ok: true, target: resolution.target, grant: scopedGrant };
  }
  return { ok: true, target: resolution.target, grant };
}
