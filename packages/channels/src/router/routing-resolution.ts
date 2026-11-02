import { z } from "zod";
import { type Gateway, Ingress, SessionTransition, type BusEvent } from "@oni/protocol";
import type { ChannelStores } from "./stores.js";
import { recordRouteDecided } from "./route-record";
import { endpointFacts } from "./endpoint-facts.js";
import { findRequestCandidates } from "./request/correlation.js";
import type { GatewayRouterPorts } from "./message-ports.js";
import type { MatchDecision } from "../automation/matcher.js";

const ScopedCorrelationClaim = SessionTransition.Correlation.required({ endpointId: true, channelId: true });
type ScopedCorrelation = z.infer<typeof ScopedCorrelationClaim>;
const RequestActionPayload = z.object({ action: z.json().catch(null).optional() });

type KernelRequestExecution =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "request"; correlation: ScopedCorrelation;
      requestedAction: SessionTransition.AllowedAction | "invalid"; record: SessionTransition.Request }>;

type KernelRouteResolution<Event extends Gateway.DeliveredEvent = Gateway.DeliveredEvent> = Readonly<{
  decision: Ingress.RoutingDecisionPayload;
  event: Event;
  requestExecution: KernelRequestExecution;
}>;

/** Physical request correlation is independent of inbound rule policy. */
export function resolveKernelRoute<Event extends Gateway.DeliveredEvent>(
  event: Event, requests: GatewayRouterPorts["requests"], at: number,
  matched?: MatchDecision["route"], sessionId?: string,
): KernelRouteResolution<Event> {
  const correlation = event.meta?.correlation === undefined ? undefined : ScopedCorrelationClaim.parse(event.meta.correlation);
  const payload = RequestActionPayload.safeParse(event.payload);
  const parsed = SessionTransition.AllowedAction.safeParse(payload.success && "action" in payload.data ? payload.data.action : "report_result");
  const requestedAction = parsed.success ? parsed.data : "invalid";
  const request = findRequestCandidates(requests.list(), correlation);
  const common = { traceId: event.traceId, time: at, inboundId: event.id, surface: event.surface, mode: "direct" as const };
  if (request.kind === "ambiguous") return { event, requestExecution: { kind: "none" }, decision: {
    ...common, stage: "request_correlation", outcome: "ambiguous",
    candidateInteractionIds: request.candidates.map((candidate) => candidate.key),
    reason: "Multiple pending waits matched the inbound message",
    factsUsed: request.candidates.map((candidate) => `request.candidate:${candidate.key}`),
  } };
  if (request.kind === "match" && correlation !== undefined) {
    const record = request.candidate.request;
    const factsUsed = [`request:${request.candidate.key}`, `request.action:${requestedAction}`];
    const decision: Ingress.RoutingDecisionPayload = requestedAction === "invalid" || !record.allowedActions.includes(requestedAction)
      ? { ...common, stage: "request_correlation", outcome: "block",
          reason: "Matched request does not allow the requested action", factsUsed: [...factsUsed, "request.action:disallowed"] }
      : { ...common, stage: "request_correlation", outcome: "route", target: "resident", sessionId: record.sessionId,
          reason: "Inbound message matched an open request", factsUsed: [...factsUsed, `request.owner:session:${record.sessionId}`] };
    return { event, decision, requestExecution: { kind: "request", correlation, requestedAction, record } };
  }
  const actor = event.meta?.actor;
  const decision: Ingress.RoutingDecisionPayload = matched === undefined
    ? { ...common, stage: "automation", outcome: "record", by: "rule/none", decision: "filtered",
        reason: "none", factsUsed: [], factsDigest: event.id }
    : { ...common, stage: "surface_default", outcome: "route", target: `session:${sessionId}`,
        sessionId, reason: "Inbound message matched a rule", factsUsed: [`rule:${matched.ruleId}`],
        ...(actor?.actorId === undefined ? {} : { actorId: actor.actorId }),
        ...(actor?.trustTier === undefined ? {} : { trustTier: actor.trustTier }),
        ...(event.meta?.inboundTreatment === undefined ? {} : { inboundTreatment: event.meta.inboundTreatment }) };
  return { event, decision, requestExecution: { kind: "none" } };
}

// The protocol owns the route stream key, decision equivalence predicate, and
// route.decided fact shape. This recorder owns only the scoped append port.
// A decision is durably appended before projection or execution. On a CAS
// conflict, the fresh decision may proceed only when it is equivalent to the
// recorded decision, including the pinned initiator endpoint (its fact names
// date from the retired reply-grant materialization, `endpoint-facts.ts`).
// Divergence and append/read failures fail closed with a typed error; no
// second fact or projection is emitted.
function pinInitiatorEndpoint(
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
      ...endpointFacts({ channel: endpoint.channel, externalId: endpoint.externalId }),
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
    pinInitiatorEndpoint(resolution.decision, event),
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
