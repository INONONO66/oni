import type { resolveKernelRoute } from "../bundles/messaging/routing-resolution.js";
import { Ingress, type Gateway, type BusEvent } from "@oni/protocol";
import type { ChannelStores } from "@oni/channels";
import { endpointFromFacts, endpointFacts } from "../bundles/messaging/endpoint-facts.js";
import { IngressRoutingError } from "@oni/channels";

/** Record before projection; a competing fact must preserve routing and reply authority. */
function recordRouteDecided(
  stores: ChannelStores,
  streamId: string,
  decision: Ingress.RoutingDecisionPayload,
  at: number,
): Ingress.RoutingDecisionPayload {
  const decisionFacts = stores.decisionFacts.port();
  if (!decisionFacts) {
    throw new IngressRoutingError(
      "route_record_failed",
      "Storage adapter does not implement decision facts — routing decisions fail closed",
      decision,
    );
  }
  let outcome: ReturnType<typeof decisionFacts.record>;
  try {
    outcome = decisionFacts.record(Ingress.routeDecidedFact(streamId, decision, at));
  } catch (error) {
    throw new IngressRoutingError(
      "route_record_failed",
      `routing decision record failed: ${error instanceof Error ? error.message : String(error)}`,
      decision,
    );
  }
  if (outcome.kind === "recorded") return decision;
  const fact = outcome.fact;
  // The persisted-wire reader returns undefined for invalid or unsupported data.
  const recorded = fact.type === Ingress.ROUTE_DECIDED_FACT_TYPE
    ? Ingress.recordedRoutingDecision(fact.data)
    : undefined;
  if (recorded === undefined) {
    throw new IngressRoutingError(
      "route_record_failed",
      `recorded routing decision read failed: ${
        fact.type === Ingress.ROUTE_DECIDED_FACT_TYPE
          ? `stream ${streamId} recorded route.decided fact failed to parse`
          : `key ${streamId} has a different recorded fact type`
      }`,
      decision,
    );
  }
  const recordedEndpoint = endpointFromFacts(recorded.factsUsed);
  const freshEndpoint = endpointFromFacts(decision.factsUsed);
  const endpointEquivalent =
    recordedEndpoint?.channel === freshEndpoint?.channel &&
    recordedEndpoint?.externalId === freshEndpoint?.externalId;
  if (!Ingress.routeDecisionsEquivalent(recorded, decision) || !endpointEquivalent) {
    // Never expose either side's authority fields in the rejection.
    throw new IngressRoutingError(
      "route_replay_divergent",
      "redelivered inbound diverges from its recorded routing decision on an execution- or authority-shaping field",
      decision,
    );
  }
  return decision;
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
export function recordIngressRoute<Event extends Gateway.DeliveredEvent>(
  stores: ChannelStores,
  resolution: ReturnType<typeof resolveKernelRoute<Event>>,
  publish: BusEvent.Sink["publish"],
  at: number,
  observe = true,
): ReturnType<typeof resolveKernelRoute<Event>> {
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
