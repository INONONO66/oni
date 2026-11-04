import { Effect } from "effect";
import type { ChannelError } from "@oni/channels";
import {
  Ingress,
  type SessionTransition,
  type Gateway,
  type RouteNotDelivered,
} from "@oni/protocol";
import { targetsOfRequest, responderCandidates, ingressEvidence } from "../bundles/messaging/request/matcher.js";
import type { GatewayRouterPorts, GatewayStores } from "../bundles/message-ports.js";
import type { resolveKernelRoute } from "../bundles/messaging/routing-resolution.js";
import { IngressRoutingError } from "@oni/channels";

// A rejected request-correlated delivery records a correction without changing
// the original route decision. Redelivery preserves the first correction fact.
function recordRouteNotDelivered(
  stores: GatewayStores,
  event: Gateway.DeliveredEvent,
  decision: Ingress.RoutingDecisionPayload,
  reason: string,
  at: number,
): void {
  // The route was just recorded through this synchronous adapter.
  const decisionFacts = stores.decisionFacts.port();
  if (decisionFacts === undefined) {
    throw new IngressRoutingError(
      "route_record_failed",
      "Storage adapter does not implement decision facts — routing corrections fail closed",
      decision,
    );
  }
  const streamId = Ingress.routeCorrectionStreamId(event);
  const correction: RouteNotDelivered = { inboundId: event.id, reason };
  let outcome: ReturnType<typeof decisionFacts.record>;
  try {
    outcome = decisionFacts.record(Ingress.routeNotDeliveredFact(streamId, correction, at));
  } catch (error) {
    throw new IngressRoutingError(
      "route_record_failed",
      `route not-delivered correction record failed: ${error instanceof Error ? error.message : String(error)}`,
      decision,
    );
  }
  if (outcome.fact.type === Ingress.ROUTE_NOT_DELIVERED_FACT_TYPE) return;
  throw new IngressRoutingError(
    "route_record_failed",
    `route not-delivered correction has a different recorded fact type on ${streamId}`,
    decision,
  );
}

type RoutedDecision = Extract<Ingress.RoutingDecisionPayload, { readonly outcome: "route" }>;

export function requireRoutedDecision(decision: Ingress.RoutingDecisionPayload): RoutedDecision {
  if (decision.outcome === "route") return decision;
  if (decision.outcome === "ambiguous") {
    throw new IngressRoutingError("route_ambiguous", decision.reason, decision);
  }
  throw new IngressRoutingError("route_blocked", decision.reason, decision);
}

export function executeRequestRoute<Event extends Gateway.DeliveredEvent>(
  stores: GatewayStores,
  resolution: ReturnType<typeof resolveKernelRoute<Event>>,
  decision: RoutedDecision,
  requests: GatewayRouterPorts["requests"],
  content: string,
  at: number,
): Effect.Effect<void, ChannelError> {
  return Effect.gen(function* () {
  const matched = resolution.requestExecution;
  if (matched.kind === "none") return;
  const record = matched.record;
  const actor = resolution.event.meta?.actor;
  const candidates = responderCandidates(
    targetsOfRequest(stores, record),
    ingressEvidence(resolution.event, matched.correlation),
  );
  let outcome: SessionTransition.Resolution = "rejected";
  if (
    record.mode === "answer" &&
    candidates.length === 1 &&
    actor?.actorId !== undefined &&
    actor.actorId === candidates[0] &&
    matched.requestedAction !== "invalid"
  ) {
    const answer = yield* requests.answer({
      inputId: resolution.event.id,
      requestId: record.requestId,
      sessionId: record.sessionId,
      receivedAt:
        record.replies.find((reply) => reply.replyId === resolution.event.id)?.receivedAt ?? at,
      principal: {
        kind: actor.trustTier === "owner" ? "owner" : "actor",
        principalId: actor.actorId,
        evidenceId: resolution.event.id,
      },
      bindingDigest: record.bindingDigest,
      inputHash: record.inputHash,
      effectHash: record.effectHash,
      generation: record.generation,
      toolsHash: record.toolsHash,
      domainRevisions: record.domainRevisions,
      decision: "answer",
      allowedAction: matched.requestedAction,
      content,
    });
    if (answer === "self_approval_suspected") return;
    outcome = answer;
  }
  if (outcome === "attached" || outcome === "resolved") return;
  const reason = `request reply rejected: ${outcome}`;
  recordRouteNotDelivered(stores, resolution.event, decision, reason, at);
  return yield* new IngressRoutingError("request_reply_rejected", reason, decision);
  });
}
