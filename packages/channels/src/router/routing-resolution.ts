import { z } from "zod";
import {
  type Gateway,
  Ingress,
  SessionTransition,
  resolveTarget,
  targetKey,
  type BusEvent,
} from "@openomni/protocol";
import type { ChannelStores } from "./stores.js";
import { claimGrantedDirect, grantedDirectSession } from "./automation/granted-direct.js";
import { recordRouteDecided } from "./route-record";
import { applyChannelGrantTreatment } from "./authority.js";
import { matchBlacklist } from "./blacklist.js";
import type { ChannelGrantResolution } from "./channel-grant.js";
import { replyGrantEndpointFacts } from "./messaging/reply-grant.js";
import { resolveRoute, type RouteState } from "./resolve-route.js";
import { findRequestCandidates, type RequestResolution } from "./request/correlation.js";
import type { GatewayRouterPorts } from "./message-ports.js";

/** Request matching requires both endpoint and channel scope pins. */
const ScopedCorrelationClaim = SessionTransition.Correlation.required({
  endpointId: true,
  channelId: true,
});
type ScopedCorrelation = z.infer<typeof ScopedCorrelationClaim>;
const RequestActionPayload = z.object({ action: z.json().catch(null).optional() });

type KernelRequestExecution =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "request";
      // Required: a request match can only come from the request tier, which
      // refuses without a correlation envelope — optionality here would
      // weaken the sender-match evidence below its real invariant.
      correlation: ScopedCorrelation;
      requestedAction: SessionTransition.AllowedAction | "invalid";
      record: SessionTransition.Request;
    }>;

type KernelRouteResolution<Event extends Gateway.DeliveredEvent = Gateway.DeliveredEvent> =
  Readonly<{
    decision: Ingress.RoutingDecisionPayload;
    event: Event;
    requestExecution: KernelRequestExecution;
  }>;

function parseCorrelation(event: Gateway.DeliveredEvent): ScopedCorrelation | undefined {
  const value = event.meta?.correlation;
  return value === undefined ? undefined : ScopedCorrelationClaim.parse(value);
}

function routeRequestState(resolution: RequestResolution): RouteState["request"] {
  switch (resolution.kind) {
    case "none":
      return { kind: "none" };
    case "ambiguous":
      return {
        kind: "ambiguous",
        candidateInteractionIds: resolution.candidates.map((candidate) => candidate.key),
      };
    case "match":
      return {
        kind: "match",
        backing: "request",
        key: resolution.candidate.key,
        recordId: resolution.candidate.request.requestId,
        sessionId: resolution.candidate.request.sessionId,
        allowed: resolution.candidate.request.allowedActions,
      };
  }
}

function kernelRequestExecution(
  resolution: RequestResolution,
  correlation: ScopedCorrelation | undefined,
  requestedAction: SessionTransition.AllowedAction | "invalid",
): KernelRequestExecution {
  switch (resolution.kind) {
    case "none":
    case "ambiguous":
      // Ambiguity is carried by the decision and rejected before execution.
      return { kind: "none" };
    case "match":
      return {
        kind: "request",
        // findRequestCandidates can return a match only for a scoped correlation.
        correlation: correlation as ScopedCorrelation,
        requestedAction,
        record: resolution.candidate.request,
      };
  }
}

type ChannelResolution = ChannelGrantResolution | undefined;

function channelState(
  resolution: ChannelResolution,
  inboundEvidenceOnly: boolean,
): RouteState["channel"] {
  if (resolution === undefined) return undefined;
  if (resolution.inboundTreatment === "drop" || resolution.grant.kind === "blocked_channel") {
    return {
      id: resolution.grant.id,
      kind: "blocked_channel",
      inboundTreatment: "drop",
    };
  }
  if (resolution.grant.kind === "broadcast_channel") {
    return {
      id: resolution.grant.id,
      kind: "broadcast_channel",
      inboundTreatment: "evidence_only",
      ...(resolution.grant.defaultTier === undefined
        ? {}
        : { defaultTier: resolution.grant.defaultTier }),
    };
  }
  return {
    id: resolution.grant.id,
    kind: "trusted_channel",
    // Treatment floor (audit A T1): a channel grant can only RAISE a sender to
    // full_access; it must never override an inbound already marked
    // evidence_only. A re-injected recovery message (unrecoverable original
    // sender) keeps the evidence_only marker to the brain — a monotonic
    // downgrade. This is now a CLOSED hole (S6): the brain consumes
    // inboundTreatment as a hard command-authority restriction — an
    // evidence_only run's tool permission is forced deny-all
    // (execution-runtime/middleware.ts) and the projection seam frames the
    // turn as evidence. The marker is protective, not merely stamped.
    inboundTreatment: inboundEvidenceOnly ? "evidence_only" : resolution.inboundTreatment,
    ...(resolution.grant.defaultTier === undefined
      ? {}
      : { defaultTier: resolution.grant.defaultTier }),
  };
}

function actorState(event: Gateway.DeliveredEvent): RouteState["actor"] {
  const actor = event.meta?.actor;
  const actorId = actor?.actorId;
  const trustTier = actor?.trustTier;
  if (actorId !== undefined && trustTier !== undefined) {
    return { id: actorId, trustTier };
  }

  return undefined;
}

function routedEvent<Event extends Gateway.DeliveredEvent>(
  event: Event,
  resolution: ChannelResolution,
  channel: RouteState["channel"],
): Event {
  if (resolution === undefined || channel === undefined || channel.kind === "blocked_channel") {
    return event;
  }
  const treated = applyChannelGrantTreatment(event, resolution.grant, channel.inboundTreatment);
  return { ...event, ...treated };
}

function blacklistState(
  stores: ChannelStores,
  event: Gateway.DeliveredEvent,
  correlation: ScopedCorrelation | undefined,
  at: number,
): RouteState["blacklist"] {
  const actor = event.meta?.actor;
  const entry = matchBlacklist(
    stores,
    {
      actorId: typeof actor?.actorId === "string" ? actor.actorId : undefined,
      endpointId:
        (typeof actor?.endpointId === "string" ? actor.endpointId : undefined) ??
        correlation?.endpointId,
      channel: correlation?.channelId ?? event.surface,
      candidates: [
        event.surface,
        ...(event.channel === undefined ? [] : [event.channel]),
        ...(correlation === undefined ? [] : [correlation.channelId]),
        `${event.surface}:${event.workspace ?? ""}:${event.channel ?? ""}`,
      ],
    },
    at,
  );
  if (entry === undefined) return undefined;
  return {
    id: entry.id,
    kind: entry.kind,
    reason: entry.reason ?? `blacklist.${entry.kind}.${entry.value}`,
  };
}

export function resolveKernelRoute<Event extends Gateway.DeliveredEvent>(
  stores: ChannelStores,
  event: Event,
  key: string,
  traceId: string,
  requests: GatewayRouterPorts["requests"],
  at: number,
  id: () => string,
  channelResolution: ChannelResolution,
): KernelRouteResolution<Event> {
  const correlation = parseCorrelation(event);
  const payload = RequestActionPayload.safeParse(event.payload);
  const parsedAction =
    payload.success && "action" in payload.data
      ? SessionTransition.AllowedAction.safeParse(payload.data.action)
      : SessionTransition.AllowedAction.safeParse("report_result");
  const requestedAction = parsedAction.success ? parsedAction.data : "invalid";
  const gatheredRequest = findRequestCandidates(requests.list(), correlation);
  const request = routeRequestState(gatheredRequest);
  const target = targetKey(resolveTarget(event));
  const blacklist = blacklistState(stores, event, correlation, at);
  const channel = channelState(channelResolution, event.meta?.inboundTreatment === "evidence_only");
  const surfaceSessionId = channel === undefined ? undefined : grantedDirectSession(stores, event, key);
  const actor = actorState(event);
  const decision = resolveRoute(
    {
      traceId,
      time: at,
      id: event.id,
      surface: event.surface,
      mode: event.mode,
      target,
      requestedAction,
    },
    {
      request,
      ...(blacklist === undefined ? {} : { blacklist }),
      ...(channel === undefined ? {} : { channel }),
      ...(actor === undefined ? {} : { actor }),
      ...(surfaceSessionId === undefined ? {} : { surfaceSessionId }),
    },
  );
  if (
    decision.outcome === "route" &&
    decision.stage === "surface_default" &&
    !decision.factsUsed.includes("channel:missing") &&
    decision.sessionId === undefined
  ) {
    const sessionId = claimGrantedDirect(stores, event, key, id());
    decision.sessionId = sessionId;
    decision.factsUsed = decision.factsUsed.map((fact) =>
      fact === "surface.default:new" ? `surface.default:${sessionId}` : fact,
    );
  }
  const requestExecution = kernelRequestExecution(gatheredRequest, correlation, requestedAction);
  return {
    decision,
    event: routedEvent(event, channelResolution, channel),
    requestExecution,
  };
}

// The protocol owns the route stream key, decision equivalence predicate, and
// route.decided fact shape. This recorder owns only the scoped append port.
// A decision is durably appended before projection or execution. On a CAS
// conflict, the fresh decision may proceed only when it is equivalent to the
// recorded decision, including the pinned reply-grant endpoint. Divergence
// and append/read failures fail closed with a typed error; no second fact or
// projection is emitted.
function pinReplyGrantEndpoint(
  decision: Ingress.RoutingDecisionPayload,
  event: Gateway.DeliveredEvent,
): Ingress.RoutingDecisionPayload {
  const actor = event.meta?.actor;
  const endpoint = actor?.endpoint;
  if (
    decision.outcome !== "route" ||
    decision.actorId === undefined ||
    actor?.actorId !== decision.actorId ||
    endpoint === undefined
  ) {
    return decision;
  }
  return {
    ...decision,
    factsUsed: [
      ...decision.factsUsed,
      ...replyGrantEndpointFacts({ channel: endpoint.channel, externalId: endpoint.externalId }),
    ],
  };
}

// Correlation is read-only (#215): request ambiguity is recorded solely by the
// appended route.decided fact, its published RoutingDecision projection, and
// the typed route_ambiguous rejection — candidates are never mutated on
// lookup.
export function recordKernelRoute<Event extends Gateway.DeliveredEvent>(
  stores: ChannelStores,
  resolution: KernelRouteResolution<Event>,
  publish: BusEvent.Sink["publish"],
  at: number,
  observe = true,
): KernelRouteResolution<Event> {
  const event = resolution.event;
  const decision = Ingress.Events.RoutingDecision.schema.parse(
    pinReplyGrantEndpoint(resolution.decision, event),
  );
  // Redelivery passes the equivalence gate or fails closed — execution below
  // always uses the fresh decision with its own fresh resolution.
  const effective = recordRouteDecided(stores, Ingress.routeStreamId(event), decision, at);
  // Observe-only projection — strictly after the append (or after the gated
  // equivalent replay); lossy by contract, published through the injected
  // sink (channels never imports the observation channel). A divergent
  // replay publishes nothing (the gate throws above).
  if (observe) publish(Ingress.Events.RoutingDecision, effective);
  return { ...resolution, decision: effective };
}
