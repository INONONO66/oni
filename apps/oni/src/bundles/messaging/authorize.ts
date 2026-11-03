import type { Actor, Channel, Gateway } from "@oni/protocol";
import type { ChannelStores } from "@oni/channels";
import { resolveSenderTargetGrant } from "./grant.js";
import { resolveInstance } from "./route.js";

type TargetDenialCode = Extract<
  Gateway.MessageDenialCode,
  "target_missing" | "target_stale" | "target_ambiguous"
>;
type TargetResolution =
  | Readonly<{ ok: true; target: Omit<Gateway.DeliveryTarget, "instance"> }>
  | Readonly<{ ok: false; code: TargetDenialCode; reason: string }>;

function deliveryTarget(
  actorId: string,
  endpoint: Actor.Endpoint,
  identity: Channel.Identity,
  conversation?: Gateway.Conversation,
): Omit<Gateway.DeliveryTarget, "instance"> {
  return {
    actorId,
    endpointId: endpoint.id,
    channel: endpoint.channel,
    externalId: endpoint.externalId,
    identity,
    ...(conversation === undefined ? {} : { conversation }),
  };
}

/**
 * The identity gate (#1569): the bot is always its own identity; the Owner's
 * account goes out only from an authenticated Owner-origin turn (the app's
 * `ownerOrigin` fact on the prepared send, never message text) and only
 * through an Owner instance whose declaration granted outbound — which is
 * exactly when that Owner instance's delivery route is mounted.
 */
function identityDenial(
  target: Omit<Gateway.DeliveryTarget, "instance">,
  input: Pick<Gateway.SendInput, "senderId" | "ownerOrigin">,
  routes: ReadonlyMap<string, Channel.Instance>,
): { readonly ok: false; readonly code: "identity_not_granted"; readonly reason: string } | undefined {
  if (target.identity !== "owner") {
    // #1600 lane R3: a platform reached only through the Owner's account has no bot to send as.
    const available = [...routes.values()].filter((route) => route.platform === target.channel);
    const bot = available.some((route) => route.identity === "bot");
    if (!bot && available.some((route) => route.identity === "owner"))
      return {
        ok: false,
        code: "identity_not_granted",
        reason: `${target.channel} is reached only through the Owner's account — send as: owner from an Owner-origin turn`,
      };
    return undefined;
  }
  if (input.ownerOrigin !== true)
    return {
      ok: false,
      code: "identity_not_granted",
      reason: `${input.senderId} may send as the Owner only from an Owner-origin turn`,
    };
  if (![...routes.values()].some((route) => route.platform === target.channel && route.identity === "owner"))
    return {
      ok: false,
      code: "identity_not_granted",
      reason: `no Owner instance of ${target.channel} grants outbound`,
    };
  return undefined;
}

function resolveExistingTarget(
  stores: ChannelStores,
  target: Gateway.MessageTarget,
  routes: ReadonlyMap<string, Channel.Instance>,
): TargetResolution {
  const as = target.identity ?? "bot";
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
    return { ok: true, target: deliveryTarget(target.actorId, endpoint, as, target.conversation) };
  }
  // A conversation lives on one surface; without a surface pin the endpoint
  // picked below could be on another channel, so the hint is refused.
  if (target.conversation !== undefined && target.surface === undefined) {
    return {
      ok: false,
      code: "target_stale",
      reason: `conversation ${target.conversation.channelId} needs target.surface to name its channel`,
    };
  }
  // A surface hint narrows to that channel's endpoints before the
  // one-or-ambiguous rule (#1485): a person on several channels is reached
  // on the one named, without the caller knowing endpoint ids.
  const platform = target.surface === undefined ? undefined : routes.get(target.surface)?.platform ?? target.surface;
  const endpoints = stores.actors
    .listEndpoints(target.actorId)
    .filter((candidate) => platform === undefined || candidate.channel === platform);
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
  return { ok: true, target: deliveryTarget(target.actorId, endpoint, as, target.conversation) };
}

/** Grant admission precedes registry access, so ungranted senders learn no target facts. */
export function authorizeSend(
  stores: ChannelStores,
  input: Pick<Gateway.SendInput, "senderId" | "target" | "operation" | "at" | "ownerOrigin">,
  grants: readonly Gateway.SenderTargetGrant[],
  routes: ReadonlyMap<string, Channel.Instance>,
):
  | {
      readonly ok: true;
      readonly target: Gateway.DeliveryTarget;
      readonly grant: Gateway.SenderTargetGrant;
    }
  | { readonly ok: false; readonly code: Gateway.MessageDenialCode; readonly reason: string } {
  const grant = resolveSenderTargetGrant(grants, {
    senderId: input.senderId,
    targetActorId: input.target.actorId,
    operation: input.operation,
    at: input.at,
  });
  if (grant === undefined) {
    return {
      ok: false,
      code: "ungranted",
      reason: `no active sender-target grant covers ${input.senderId} -> ${input.target.actorId} (${input.operation})`,
    };
  }
  const resolution = resolveExistingTarget(stores, input.target, routes);
  if (!resolution.ok) return resolution;
  const identity = identityDenial(resolution.target, input, routes);
  if (identity !== undefined) return identity;
  const surface = input.target.surface;
  const selected = resolveInstance(
    routes, resolution.target.channel, resolution.target.identity,
    surface !== undefined && surface !== resolution.target.channel ? surface : undefined,
  );
  if ("code" in selected) return { ok: false, ...selected };
  return { ok: true, target: { ...resolution.target, instance: selected.instance }, grant };
}
