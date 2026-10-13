import type { Actor, Ingress } from "@openomni/protocol";
import { effectiveTrustTier } from "./effective-tier.js";

/**
 * External routing arms of THE resolveRoute fold. Internal mode never crosses
 * the perimeter, so this router owns external mode only. Decision strings,
 * stages, and factsUsed are byte-frozen wire vocabulary.
 */
type RouteInbound = {
  readonly traceId: string;
  readonly time: number;
  readonly id: string;
  readonly surface: string;
  readonly mode: "direct";
  readonly target: string;
  readonly requestedAction?: string;
};

type RouteRequest =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "match";
      backing: "request";
      key: string;
      recordId: string;
      sessionId: string;
      allowed: readonly string[];
    }>
  | Readonly<{
      kind: "ambiguous";
      candidateInteractionIds: readonly string[];
    }>;

type RouteChannel =
  | {
      readonly id: string;
      readonly kind: "trusted_channel";
      readonly inboundTreatment: "full_access" | "evidence_only";
      readonly defaultTier?: Actor.TrustTier;
    }
  | {
      readonly id: string;
      readonly kind: "broadcast_channel";
      readonly inboundTreatment: "evidence_only";
      readonly defaultTier?: Actor.TrustTier;
    }
  | {
      readonly id: string;
      readonly kind: "blocked_channel";
      readonly inboundTreatment: "drop";
    };

type RouteActor = {
  readonly id: string;
  readonly trustTier: Actor.TrustTier;
};

export type RouteState = {
  readonly blacklist?: {
    readonly id: string;
    readonly kind: Actor.BlacklistKind;
    readonly reason?: string;
  };
  readonly request: RouteRequest;
  readonly channel?: RouteChannel;
  readonly actor?: RouteActor;
  readonly surfaceSessionId?: string;
};

type RouteCommon = Readonly<{
  traceId: string;
  time: number;
  inboundId: string;
  surface: string;
  mode: "direct";
}>;

type RequestResolution =
  | Readonly<{ decision: Ingress.RoutingDecisionPayload }>
  | Readonly<{ facts: readonly string[] }>;

function routeCommon(inbound: RouteInbound): RouteCommon {
  return {
    traceId: inbound.traceId,
    time: inbound.time,
    inboundId: inbound.id,
    surface: inbound.surface,
    mode: inbound.mode,
  };
}

function resolveBlacklist(
  common: RouteCommon,
  blacklist: NonNullable<RouteState["blacklist"]>,
): Ingress.RoutingDecisionPayload {
  return {
    ...common,
    stage: "blacklist",
    outcome: "drop",
    reason: "Inbound principal matched the blacklist",
    factsUsed: [
      `blacklist:${blacklist.id}`,
      `blacklist.kind:${blacklist.kind}`,
      ...(blacklist.reason === undefined ? [] : [`blacklist.reason:${blacklist.reason}`]),
    ],
  };
}

function resolveRequest(
  inbound: RouteInbound,
  request: RouteRequest,
  common: RouteCommon,
): RequestResolution {
  if (request.kind === "none") return { facts: ["request:none"] };
  if (request.kind === "ambiguous") {
    return {
      decision: {
        ...common,
        stage: "request_correlation",
        outcome: "ambiguous",
        candidateInteractionIds: [...request.candidateInteractionIds],
        reason: "Multiple pending waits matched the inbound message",
        factsUsed: request.candidateInteractionIds.map((id) => `request.candidate:${id}`),
      },
    };
  }

  const action = inbound.requestedAction;
  if (action === undefined || !request.allowed.includes(action)) {
    // Fail closed: a matched durable request never falls through to
    // surface routing — a disallowed action is a typed block.
    return {
      decision: {
        ...common,
        stage: "request_correlation",
        outcome: "block",
        reason: "Matched request does not allow the requested action",
        factsUsed: [
          `request:${request.key}`,
          `request.action:${action ?? "missing"}`,
          "request.action:disallowed",
        ],
      },
    };
  }
  return {
    decision: {
      ...common,
      stage: "request_correlation",
      outcome: "route",
      target: "resident",
      sessionId: request.sessionId,
      reason: "Inbound message matched an open request",
      factsUsed: [
        `request:${request.key}`,
        `request.action:${action}`,
        `request.owner:session:${request.sessionId}`,
      ],
    },
  };
}

function resolveChannelRoute(
  inbound: RouteInbound,
  state: RouteState,
  common: RouteCommon,
  waitFacts: readonly string[],
): Ingress.RoutingDecisionPayload {
  const channel = state.channel;
  if (channel === undefined) {
    return {
      ...common,
      stage: "channel_ceiling",
      outcome: "block",
      reason: "External inbound message has no channel grant",
      factsUsed: [...waitFacts, "channel:missing"],
    };
  }

  switch (channel.kind) {
    case "blocked_channel":
      return {
        ...common,
        stage: "channel_ceiling",
        outcome: "block",
        inboundTreatment: channel.inboundTreatment,
        reason: "Channel grant blocks inbound messages",
        factsUsed: [
          ...waitFacts,
          `channel:${channel.id}`,
          `channel.kind:${channel.kind}`,
          `channel.treatment:${channel.inboundTreatment}`,
        ],
      };
    case "broadcast_channel":
    case "trusted_channel":
      break;
  }

  const channelFacts = [
    ...waitFacts,
    `channel:${channel.id}`,
    `channel.kind:${channel.kind}`,
    `channel.treatment:${channel.inboundTreatment}`,
  ];
  const actorId = state.actor?.id;
  const trustTier = effectiveTrustTier(state.actor?.trustTier, channel.defaultTier);

  if (trustTier === undefined) {
    return {
      ...common,
      stage: "actor_identity",
      outcome: "block",
      reason: "Inbound actor is unknown and the channel has no default trust tier",
      factsUsed: [...channelFacts, "actor:unknown", "channel.default-tier:missing"],
    };
  }

  return {
    ...common,
    stage: "surface_default",
    outcome: "route",
    target: inbound.target,
    ...(state.surfaceSessionId === undefined ? {} : { sessionId: state.surfaceSessionId }),
    ...(actorId === undefined ? {} : { actorId }),
    trustTier,
    inboundTreatment: channel.inboundTreatment,
    reason: "Inbound message routed to the surface session",
    factsUsed: [
      ...channelFacts,
      ...(actorId === undefined
        ? [`channel.default-tier:${trustTier}`]
        : [`actor:${actorId}`, `actor.trust-tier:${trustTier}`]),
      state.surfaceSessionId === undefined
        ? "surface.default:new"
        : `surface.default:${state.surfaceSessionId}`,
      `target:${inbound.target}`,
    ],
  };
}

export function resolveRoute(
  inbound: RouteInbound,
  state: RouteState,
): Ingress.RoutingDecisionPayload {
  const common = routeCommon(inbound);
  if (state.blacklist !== undefined) return resolveBlacklist(common, state.blacklist);

  const waitResolution = resolveRequest(inbound, state.request, common);
  if ("decision" in waitResolution) return waitResolution.decision;

  return resolveChannelRoute(inbound, state, common, waitResolution.facts);
}
