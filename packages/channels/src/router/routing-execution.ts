import { Effect } from "effect";
import type { ChannelError } from "../errors";
import {
  Ingress,
  type SessionTransition,
  type Gateway,
  type RouteNotDelivered,
} from "@oni/protocol";
import type { ChannelStores } from "./stores.js";
import { targetsOfRequest, responderCandidates, ingressEvidence } from "./request/matcher.js";
import type { GatewayRouterPorts } from "./message-ports.js";
import type { resolveKernelRoute } from "./routing-resolution.js";
import { IngressRoutingError } from "../errors";

// A rejected request-correlated delivery records a correction without changing
// the original route decision. Redelivery preserves the first correction fact.
function recordRouteNotDelivered(
  stores: ChannelStores,
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

function factValue(decision: Ingress.RoutingDecisionPayload, prefix: string): string | undefined {
  const fact = decision.factsUsed.find((candidate) => candidate.startsWith(prefix));
  return fact?.slice(prefix.length);
}

function terminalMessage(decision: Ingress.RoutingDecisionPayload): string {
  if (decision.stage === "channel_ceiling") {
    if (decision.factsUsed.includes("channel:missing")) return "channel_grant.missing";
    const kind = factValue(decision, "channel.kind:");
    const treatment = factValue(decision, "channel.treatment:");
    if (kind !== undefined && treatment !== undefined) return `channel_grant.${kind}.${treatment}`;
  }
  if (decision.stage === "actor_identity") {
    return "actor is not authorized to create top-level inbound work";
  }
  return decision.reason;
}

export function requireRoutedDecision(decision: Ingress.RoutingDecisionPayload): RoutedDecision {
  if (decision.outcome === "route") return decision;
  if (decision.outcome === "ambiguous") {
    throw new IngressRoutingError("route_ambiguous", decision.reason, decision);
  }
  throw new IngressRoutingError("route_blocked", terminalMessage(decision), decision);
}

export function executeRequestRoute<Event extends Gateway.DeliveredEvent>(
  stores: ChannelStores,
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
    outcome = yield* requests.answer({
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
  }
  if (outcome === "attached" || outcome === "resolved") return;
  const reason = `request reply rejected: ${outcome}`;
  recordRouteNotDelivered(stores, resolution.event, decision, reason, at);
  return yield* new IngressRoutingError("request_reply_rejected", reason, decision);
  });
}
