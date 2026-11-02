import { z } from "zod";
import { type Gateway, Ingress, SessionTransition } from "@oni/protocol";
import type { ChannelStores } from "@oni/channels";
import { findRequestCandidates } from "@oni/channels";
import type { GatewayRouterPorts } from "./message-ports.js";
import type { MatchDecision } from "@oni/channels";

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
  event: Event, requests: Pick<GatewayRouterPorts["requests"], "list">, at: number,
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
  // A rule admits a message, never a sender's authority: the registry's tier
  // decides that, and a sender it does not hold reads as evidence (§8.12).
  const treatment = event.meta?.inboundTreatment ?? (actor?.trustTier === undefined ? "evidence_only" : undefined);
  const decision: Ingress.RoutingDecisionPayload = matched === undefined
    ? { ...common, stage: "automation", outcome: "record", by: "rule/none", decision: "filtered",
        reason: "none", factsUsed: [], factsDigest: event.id }
    : { ...common, stage: "surface_default", outcome: "route", target: `session:${sessionId}`,
        sessionId, reason: "Inbound message matched a rule", factsUsed: [`rule:${matched.ruleId}`],
        ...(actor?.actorId === undefined ? {} : { actorId: actor.actorId }),
        ...(actor?.trustTier === undefined ? {} : { trustTier: actor.trustTier }),
        ...(treatment === undefined ? {} : { inboundTreatment: treatment }) };
  return { event, decision, requestExecution: { kind: "none" } };
}
