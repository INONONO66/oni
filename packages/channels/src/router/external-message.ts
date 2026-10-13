import { Effect } from "effect";
import type { ChannelStores } from "./stores.js";
import type { PolicyEvaluationInput } from "@openomni/agent";
import { Channel, type Gateway, Ingress, resolveTarget as eventTarget, targetKey } from "@openomni/protocol";
import { judgeAndMatch } from "../automation/judge.js";
import type { MatchDecision, PendingGroup } from "../automation/matcher.js";
import type { ingressInput } from "./automation/input.js";
import { newTraceId } from "../support/trace";
import { webSocketSenderTier } from "./channel-grant";
import { resolveIngressActor } from "./actor-resolver";
import { isAuthorizedTopLevelActor } from "./authority-actor";
import { recordKernelRoute, resolveKernelRoute } from "./routing-resolution";
import { recordAutomationDuplicate } from "./automation/ledger.js";
import type { GatewayRouterPorts } from "./message-ports";
import { evaluateSocialBudget } from "./messaging/social-budget";
import type { IngressFacts } from "../automation/facts.js";

function admitWebSocketOwner(
  stores: ChannelStores,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>,
): void {
  if (
    sender.surface !== "ws" ||
    stores.actors.resolveEndpoint("ws", sender.externalId) !== undefined ||
    webSocketSenderTier(stores, sender.externalId) !== "owner"
  )
    return;
  const actorId = `ws:owner:${sender.externalId}`;
  stores.actors.registerIdentity({ id: actorId, kind: "human", trustTier: "owner" });
  stores.actors.registerEndpoint({ id: `ws:${sender.externalId}`, actorId,
    channel: "ws", externalId: sender.externalId });
}

function resolveIngress(
  stores: ChannelStores, sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  facts: IngressFacts, ports: GatewayRouterPorts, at: number,
  ingress: ReturnType<typeof ingressInput>,
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
    id: ingress.input.eventId,
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
  const route = resolveKernelRoute(stores, event, surfaceKey, event.traceId, ports.requests, at, ports.id);
  return { surfaceKey, existing, event: route.event, route, ...ingress };
}

function automationActor(route: ReturnType<typeof resolveKernelRoute>) {
  const actor = route.event.meta?.actor;
  return route.decision.outcome === "block" && route.decision.stage === "channel_ceiling" &&
    route.decision.factsUsed.includes("channel:missing") &&
    actor?.actorId !== undefined && actor.trustTier !== undefined ? actor : undefined;
}

function grantAutomation(route: ReturnType<typeof resolveKernelRoute>, automationId?: string) {
  const actor = automationActor(route);
  if (actor === undefined || automationId === undefined) return route;
  return { ...route, decision: Ingress.Events.RoutingDecision.schema.parse({
    ...route.decision, outcome: "route", stage: "surface_default",
    target: targetKey(eventTarget(route.event)), actorId: actor.actorId, trustTier: actor.trustTier,
    reason: "Matched automation grants the identified inbound",
    factsUsed: [...route.decision.factsUsed, `actor:${actor.actorId}`, `automation:${automationId}`],
  }) };
}

function matchIngress(
  stores: ChannelStores, ports: GatewayRouterPorts, at: number,
  pending: readonly PendingGroup[], resolved: ReturnType<typeof resolveIngress>,
) {
  return Effect.gen(function* () {
    const { route, addressed, existing, input, surfaceKey } = resolved;
    if ((route.decision.outcome !== "route" && automationActor(route) === undefined) ||
        route.requestExecution.kind === "request")
      return { rows: [], pending } satisfies MatchDecision;
    const record = route.decision.outcome === "route" && route.decision.stage === "surface_default"
      ? stores.automations.get(`granted-direct:${surfaceKey}`)?.record : undefined;
    const records = stores.automations.list()
      .filter((entry) => entry.approved || entry.record.createdBy === "owner")
      .map((entry) => entry.record);
    const userRecords = records.filter((candidate) => candidate.id !== record?.id &&
      !candidate.id.startsWith("granted-direct:"));
    const options = {
      now: at, pending,
      ...(addressed && isAuthorizedTopLevelActor(route.event) &&
        !route.decision.factsUsed.includes("channel:missing")
        ? { conversation: `session:${existing ?? route.decision.sessionId}` } : {}),
      matchedToday: (automationId: string) => stores.automations.matchedToday(automationId, at),
    };
    let outcome = yield* judgeAndMatch(addressed && record !== undefined
      ? [...userRecords, record] : userRecords, input, options, ports.judge);
    if (outcome.route === undefined &&
        !outcome.pending.some((group) => group.inputs.some((member) => member.eventId === input.eventId)) &&
        record !== undefined) {
      const fallback = yield* judgeAndMatch([record], input, options, ports.judge);
      outcome = { ...fallback, rows: outcome.rows.length === 0 ? fallback.rows : outcome.rows };
    }
    return outcome;
  });
}

function projectDisposition(
  route: ReturnType<typeof resolveIngress>["route"],
  outcome: Effect.Success<ReturnType<typeof matchIngress>>,
  eventId: string,
) {
  if (route.requestExecution.kind === "request") return undefined;
  if (outcome.route !== undefined) return undefined;
  return outcome.pending.some((group) => group.inputs.some((member) => member.eventId === eventId))
    ? "grouped" : undefined;
}

function resolveTarget(
  route: ReturnType<typeof resolveIngress>["route"],
  outcome: Effect.Success<ReturnType<typeof matchIngress>>,
  fallback: string,
  id: () => string,
) {
  if (route.decision.outcome === "route" && route.requestExecution.kind === "request")
    return route.decision.sessionId ?? fallback;
  if (outcome.route?.target === "new") return id();
  if (outcome.route?.target.startsWith("session:")) return outcome.route.target.slice("session:".length);
  return route.decision.outcome === "route" ? route.decision.sessionId ?? fallback : fallback;
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
  identities: ReturnType<typeof resolveIngress>["identities"],
  addressed: boolean,
  egressBudget: boolean,
): Extract<NonNullable<PolicyEvaluationInput["message"]>, { sender: "external" }> {
  const addressee = addressed ? "bot"
    : identities.some((identity) => identity.trustTier === "owner") ? "owner" : "ambient";
  return {
    sender: "external",
    ...(route.decision.trustTier === undefined ? {} : { senderTier: route.decision.trustTier }),
    addressee, identity: route.decision.outcome === "route" || automationActor(route) !== undefined,
    grantTier: route.decision.outcome === "route" &&
      (route.requestExecution.kind === "request" ||
        (!route.decision.factsUsed.includes("channel:missing") && isAuthorizedTopLevelActor(route.event))),
    egressBudget, eventIdUnique: true,
    replyCorrelation: route.decision.outcome !== "ambiguous",
  };
}

/** Project raw facts and the stored record decision before any session delivery. */
export function externalMessage(
  stores: ChannelStores,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  facts: IngressFacts,
  ports: GatewayRouterPorts,
  at: number,
  budgets: readonly Gateway.SocialBudget[],
  pending: readonly PendingGroup[],
  ingress: ReturnType<typeof ingressInput>,
  closingRoute?: NonNullable<MatchDecision["route"]>,
) {
  return Effect.gen(function* () {
    const resolved = resolveIngress(stores, sender, facts, ports, at, ingress);
    const { event, identities, addressed, surfaceKey } = resolved;
    const outcome: MatchDecision = closingRoute === undefined
      ? yield* matchIngress(stores, ports, at, pending, resolved)
      : { route: closingRoute, rows: [], pending };
    const granted = grantAutomation(resolved.route, outcome.route?.automationId);
    const route = closingRoute === undefined
      ? recordKernelRoute(stores, granted, ports.sink, at) : granted;
    const disposition = projectDisposition(route, outcome, event.id);
    const target = resolveTarget(route, outcome, resolved.existing ?? ports.id(), ports.id);
    const egressBudget = resolveEgressBudget(route, budgets, stores, event.meta?.actor?.actorId, target, at);
    const message = buildMessage(route, identities, addressed, egressBudget);
    const automation = route.decision.outcome === "route" && route.requestExecution.kind !== "request"
      ? outcome.route : undefined;
    const automationGrant = automation?.automationId !== undefined &&
      !automation.automationId.startsWith("granted-direct:");
    return { route, event, target, surfaceKey,
      message: { ...message, grantTier: message.grantTier || automationGrant }, facts,
      content: automation?.kind === "action" ? JSON.stringify(automation.body)
        : automation?.origin.body ?? facts.render,
      pending: outcome.pending,
      disposition: disposition ?? (automation === undefined && !message.grantTier &&
        outcome.rows[0]?.stage === "automation" ? outcome.rows[0].decision : undefined),
      decision: outcome.rows[0], automation };
  });
}

/** Replays retain the frozen route; completed deliveries append only a dedupe observation. */
export function replayExternal(stores: ChannelStores,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>, facts: IngressFacts,
  ports: GatewayRouterPorts, at: number, budgets: readonly Gateway.SocialBudget[],
  input: ReturnType<typeof ingressInput>) {
  return Effect.gen(function* () {
    const record = stores.automations.decisions(input.input.eventId)[0];
    if (record?.stage === "automation" && record.by.startsWith("automation/")) {
      const resolved = resolveIngress(stores, sender, facts, ports, at, input);
      const fact = stores.decisionFacts.port()?.head(Ingress.routeStreamId(resolved.event));
      const original = fact === undefined ? undefined : Ingress.recordedRoutingDecision(fact.data);
      const grant = original?.factsUsed.find((value) => value.startsWith("automation:"));
      recordKernelRoute(stores, grantAutomation(resolved.route, grant?.slice("automation:".length)),
        ports.sink, at, false);
    }
    const retry = stores.automations.pendingDelivery(input.input.eventId);
    if (retry === undefined) {
      if (record !== undefined) recordAutomationDuplicate(stores, ports.sink, { ...record, time: at });
      return undefined;
    }
    return yield* externalMessage(stores, sender, facts, ports, at, budgets, [], input, retry);
  });
}
