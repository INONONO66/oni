import { Effect } from "effect";
import type { ChannelStores } from "./stores.js";
import type { PolicyEvaluationInput } from "@openomni/agent";
import { Channel, Ingress, type Gateway } from "@openomni/protocol";
import { judgeAndMatch } from "../automation/judge.js";
import type { PendingGroup } from "../automation/matcher.js";
import { inboundIdOf } from "./inbound-id.js";
import { newTraceId } from "../support/trace";
import { resolveChannelGrant } from "./channel-grant";
import { resolveIngressActor } from "./actor-resolver";
import { isAuthorizedTopLevelActor } from "./authority-actor";
import { resolveAndRecordRoute } from "./routing-resolution";
import type { GatewayRouterPorts } from "./message-ports";
import { evaluateSocialBudget } from "./messaging/social-budget";

function admitWebSocketOwner(
  stores: ChannelStores,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>,
): void {
  if (
    sender.surface !== "ws" ||
    stores.actors.resolveEndpoint("ws", sender.externalId) !== undefined ||
    resolveChannelGrant(stores, { surface: "ws", sender: sender.externalId })?.grant.defaultTier !==
      "owner"
  )
    return;
  const actorId = `ws:owner:${sender.externalId}`;
  stores.actors.registerIdentity({ id: actorId, kind: "human", trustTier: "owner" });
  stores.actors.registerEndpoint({ id: `ws:${sender.externalId}`, actorId,
    channel: "ws", externalId: sender.externalId });
}

function resolveIngress(
  stores: ChannelStores, sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  facts: Gateway.IngressFacts, ports: GatewayRouterPorts, at: number,
) {
  const surfaceKey = Channel.SurfaceKey.fromChannel({
    surface: facts.surface, namespace: facts.workspaceId ?? facts.surface,
    kind: facts.dm ? "dm" : "channel", id: facts.channelId,
    ...(facts.reply?.threadId === undefined ? {} : { threadId: facts.reply.threadId }),
  });
  const existing = stores.surfaceKeys.lookup(surfaceKey);
  const reply = facts.reply ?? { chain: [] };
  admitWebSocketOwner(stores, sender);
  const event = resolveIngressActor(stores, {
    id: inboundIdOf(facts),
    traceId: newTraceId(ports.id), surface: facts.surface,
    ...(facts.workspaceId === undefined ? {} : { workspace: facts.workspaceId }),
    channel: facts.channelId, userId: sender.externalId, payload: facts.payload,
    mode: "direct", meta: {
      surfaceKey, correlation: {
        ...reply,
        endpointId: stores.actors.resolveEndpoint(sender.surface, sender.externalId, facts.workspaceId)
          ?.endpoint.id ?? `${sender.surface}:${sender.externalId}`,
        channelId: facts.channelId,
        externalConversationId: reply.externalConversationId ?? surfaceKey,
      },
    },
  }, at);
  const route = resolveAndRecordRoute(stores, event, surfaceKey, event.traceId,
    ports.sink, ports.requests, at, ports.id);
  const identities = facts.addressees.flatMap((addressee) => {
    const resolved = stores.actors.resolveEndpoint(facts.surface, addressee.externalId, facts.workspaceId);
    return resolved === undefined ? [] : [resolved.identity];
  });
  const addressed = facts.dm || identities.some((identity) => identity.kind === "resident");
  const input = Ingress.Input.parse({
    eventId: event.id, surface: facts.surface, event: facts.event ?? "message",
    channelId: facts.channelId, threadId: facts.reply?.threadId, workspaceId: facts.workspaceId,
    author: facts.author ?? { externalId: sender.externalId, isBot: false },
    dm: facts.dm, mentionsBot: addressed, body: facts.render, receivedAt: at,
  });
  return { surfaceKey, existing, event, route, identities, addressed, input };
}

function matchIngress(
  stores: ChannelStores, ports: GatewayRouterPorts, at: number,
  pending: readonly PendingGroup[], resolved: ReturnType<typeof resolveIngress>,
) {
  return Effect.gen(function* () {
    const { route, addressed, existing, input, surfaceKey, event } = resolved;
    const record = route.decision.outcome === "route" && route.decision.stage === "surface_default"
      ? stores.automations.get(`granted-direct:${surfaceKey}`)?.record : undefined;
    const records = stores.automations.list().map((entry) => entry.record);
    const userRecords = records.filter((candidate) => candidate.id !== record?.id &&
      !candidate.id.startsWith("granted-direct:"));
    const options = {
      now: at, pending,
      ...(addressed && existing !== undefined ? { conversation: `session:${existing}` } : {}),
      matchedToday: (automationId: string) => stores.automations.matchedToday(automationId, at),
      seen: pending.some((group) => group.inputs.some((member) => member.eventId === event.id)) ||
        stores.automations.decisions(event.id).some((decision) =>
          decision.stage === "automation" && decision.decision === "matched"),
    };
    let outcome = yield* judgeAndMatch(addressed && record !== undefined
      ? [record, ...userRecords] : userRecords, input, options, ports.judge);
    if (!addressed && outcome.route === undefined && outcome.rows.length === 0 &&
        !outcome.pending.some((group) => group.inputs.some((member) => member.eventId === input.eventId)) &&
        record !== undefined) {
      outcome = yield* judgeAndMatch([record], input, options, ports.judge);
    }
    for (const decision of outcome.rows) stores.automations.record(decision);
    return outcome;
  });
}

function projectDisposition(
  route: ReturnType<typeof resolveIngress>["route"],
  outcome: Effect.Success<ReturnType<typeof matchIngress>>,
  eventId: string,
) {
  if (route.requestExecution.kind === "request" || route.decision.outcome !== "route") return undefined;
  if (outcome.route !== undefined) return undefined;
  const row = outcome.rows.find((decision) => decision.stage === "automation" &&
    (decision.decision === "deduped" || decision.decision === "refused" || decision.decision === "filtered"));
  if (row?.stage === "automation") {
    if (row.decision === "refused") return row.reason;
    return row.decision === "deduped" ? "message.external.event_id_dedupe" : row.decision;
  }
  return outcome.pending.some((group) => group.inputs.some((member) => member.eventId === eventId))
    ? "grouped" : undefined;
}

function resolveTarget(
  route: ReturnType<typeof resolveIngress>["route"],
  outcome: Effect.Success<ReturnType<typeof matchIngress>>,
  eventId: string,
) {
  if (route.decision.outcome === "route" && route.requestExecution.kind === "request")
    return route.decision.sessionId ?? eventId;
  if (outcome.route?.target.startsWith("session:")) return outcome.route.target.slice("session:".length);
  return route.decision.outcome === "route" ? route.decision.sessionId ?? eventId : eventId;
}

function resolveEgressBudget(
  route: ReturnType<typeof resolveIngress>["route"],
  budgets: readonly Gateway.SocialBudget[],
  stores: ChannelStores,
  actorId: string | undefined,
  target: string,
  at: number,
): boolean {
  if (route.requestExecution.kind === "request") return true;
  const budget = budgets.find((candidate) => candidate.targetActorId === actorId);
  if (budget === undefined) return true;
  return evaluateSocialBudget(budget,
    stores.egressBudgets.read(target, budget.targetActorId, at - budget.windowMs),
    { class: "converse", at }) === "allow";
}

function buildMessage(
  route: ReturnType<typeof resolveIngress>["route"],
  outcome: Effect.Success<ReturnType<typeof matchIngress>>,
  identities: ReturnType<typeof resolveIngress>["identities"],
  addressed: boolean,
  egressBudget: boolean,
): NonNullable<PolicyEvaluationInput["message"]> {
  const addressee = outcome.route?.kind === "prompt" && addressed ? "bot"
    : identities.some((identity) => identity.trustTier === "owner") ? "owner" : "ambient";
  return {
    sender: "external",
    ...(route.decision.trustTier === undefined ? {} : { senderTier: route.decision.trustTier }),
    addressee, identity: route.decision.outcome === "route",
    grantTier: route.decision.outcome === "route" &&
      (route.requestExecution.kind === "request" || isAuthorizedTopLevelActor(route.event)),
    egressBudget, eventIdUnique: true,
    replyCorrelation: route.decision.outcome !== "ambiguous",
  };
}

/** Project raw facts and the stored record decision before any session delivery. */
export function externalMessage(
  stores: ChannelStores,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  facts: Gateway.IngressFacts,
  ports: GatewayRouterPorts,
  at: number,
  budgets: readonly Gateway.SocialBudget[],
  pending: readonly PendingGroup[],
) {
  return Effect.gen(function* () {
    const resolved = resolveIngress(stores, sender, facts, ports, at);
    const { event, route, identities, addressed, surfaceKey } = resolved;
    const outcome = yield* matchIngress(stores, ports, at, pending, resolved);
    const disposition = projectDisposition(route, outcome, event.id);
    const target = resolveTarget(route, outcome, event.id);
    const egressBudget = resolveEgressBudget(route, budgets, stores, event.meta?.actor?.actorId, target, at);
    const message = buildMessage(route, outcome, identities, addressed, egressBudget);
    return { route, event, target, surfaceKey, message, content: facts.render,
      pending: outcome.pending, disposition,
      automation: outcome.route?.kind === "action" && route.decision.outcome === "route"
        ? outcome.route : undefined };
  });
}
