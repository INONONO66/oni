import { Ingress } from "@openomni/protocol";
import type { ChannelStores } from "./stores.js";
import { endpointFromFacts } from "./endpoint-facts";
import { IngressRoutingError } from "../errors";

/** Record before projection; a competing fact must preserve routing and reply authority. */
export function recordRouteDecided(
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
  let recorded: Ingress.RoutingDecisionPayload | undefined;
  try {
    // Pre-0025 facts are upcast by the protocol's bounded persisted-wire reader.
    recorded =
      fact.type === Ingress.ROUTE_DECIDED_FACT_TYPE
        ? Ingress.recordedRoutingDecision(fact.data)
        : undefined;
  } catch (error) {
    throw new IngressRoutingError(
      "route_record_failed",
      `recorded routing decision read failed: ${error instanceof Error ? error.message : String(error)}`,
      decision,
    );
  }
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
