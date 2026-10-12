import type { DecisionFact, RouteNotDelivered } from "../ledger/index.js";
import type { RoutingDecisionPayload } from "../event/ingress.js";

/**
 * Shared route.decided recorder core (batch ② commit 1). The two ingress
 * arms — the gateway router (external, @openomni/channels) and the brain's
 * internal product path — may not import each other
 * (openomni↛channels = 0/0), so the PURE parts of their once byte-identical
 * `route.decided` recorders are hoisted here: both arms import these and do
 * their OWN durable record (each through its own scoped `DecisionFacts.port()`
 * and its own package-local typed error). Precedent: the #707 slice-1 wait
 * physical request matcher in channels.
 */

/** The minimal event scope the route owner-stream key is derived from. */
export type RouteStreamScope = Readonly<{
  surface: string;
  workspace?: string;
  channel?: string;
  id: string;
}>;

/** The ONE `route.decided` fact type string — shared so it cannot drift. */
export const ROUTE_DECIDED_FACT_TYPE = "route.decided";

// Route owner-stream key (#510 review fix F1): normalizer-minted inbound ids
// are only unique WITHIN a channel — telegram normalizer ids are per-chat
// counters and the github normalizer fallback is
// `${eventKey}-${issueNumber}-${sender}-${len}` — so the stream identity
// carries the surface + workspace + channel scope. Without it a colliding id
// from another channel (or an attacker-chosen channel) could preempt or
// replay a foreign decision. Each component is URI-encoded (delimiter
// safety): the protocol schemas allow plain strings, so a ":" inside a
// channel or id could otherwise forge a foreign scope's key (e.g.
// channel "C1" + id "x:5" colliding with channel "C1:x" + id "5").
function scopedStreamId(prefix: string, scope: RouteStreamScope): string {
  const component = (value: string | undefined) => encodeURIComponent(value ?? "");
  return `${prefix}:${component(scope.surface)}:${component(scope.workspace)}:${component(scope.channel)}:${component(scope.id)}`;
}

export function routeStreamId(scope: RouteStreamScope): string {
  return scopedStreamId("route", scope);
}

/** The record input for a `route.decided` fact. */
export function routeDecidedFact(
  key: string,
  decision: RoutingDecisionPayload,
  timeCreated: number,
): DecisionFact.Record {
  return { key, type: ROUTE_DECIDED_FACT_TYPE, data: decision, timeCreated };
}

/** The ONE `route.not_delivered` correction fact type string — shared so it cannot drift. */
export const ROUTE_NOT_DELIVERED_FACT_TYPE = "route.not_delivered";

// The route_correction owner-stream key (batch ② commit 4): the SAME scope +
// inbound id as the route decision it corrects, on a distinct class prefix so
// the route stream's single-fact route.decided replay gate is untouched.
export function routeCorrectionStreamId(scope: RouteStreamScope): string {
  return scopedStreamId("route_correction", scope);
}

/** The record input for a `route.not_delivered` correction fact. */
export function routeNotDeliveredFact(
  key: string,
  correction: RouteNotDelivered,
  timeCreated: number,
): DecisionFact.Record {
  return { key, type: ROUTE_NOT_DELIVERED_FACT_TYPE, data: correction, timeCreated };
}

// Replay equivalence gate (#510 review fix F2): an existing fact means this
// inbound was ALREADY decided. The recorded decision and the fresh one must
// agree on every execution- and authority-shaping field — stage, outcome,
// target, sessionId, actorId, trustTier, inboundTreatment, and for ledger rows
// the automation verdict and its author (decision, by) — before the redelivery
// may proceed. Fields like traceId/time/reason/factsUsed are delivery-local and
// deliberately excluded.
export function routeDecisionsEquivalent(
  recorded: RoutingDecisionPayload,
  fresh: RoutingDecisionPayload,
): boolean {
  const [recordedDecision, recordedBy] = ledgerVerdict(recorded);
  const [freshDecision, freshBy] = ledgerVerdict(fresh);
  return (
    recorded.stage === fresh.stage &&
    recorded.outcome === fresh.outcome &&
    recorded.target === fresh.target &&
    recorded.sessionId === fresh.sessionId &&
    recorded.actorId === fresh.actorId &&
    recorded.trustTier === fresh.trustTier &&
    recorded.inboundTreatment === fresh.inboundTreatment &&
    recordedDecision === freshDecision &&
    recordedBy === freshBy
  );
}

function ledgerVerdict(
  decision: RoutingDecisionPayload,
): readonly [string | undefined, string | undefined] {
  return "decision" in decision ? [decision.decision, decision.by] : [undefined, undefined];
}
