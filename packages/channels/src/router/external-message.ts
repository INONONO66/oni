import { Effect } from "effect";
import type { ChannelStores } from "./stores.js";
import type { PolicyEvaluationInput } from "@openomni/agent";
import { Channel, type Gateway } from "@openomni/protocol";
import { judgeAndMatch } from "../automation/judge.js";
import type { MatchDecision, PendingGroup } from "../automation/matcher.js";
import type { ingressInput } from "./automation/input.js";
import { newTraceId } from "../support/trace";
import { resolveChannelGrant } from "./channel-grant";
import { resolveIngressActor } from "./actor-resolver";
import { isAuthorizedTopLevelActor } from "./authority-actor";
import { resolveAndRecordRoute, resolveKernelRoute } from "./routing-resolution";
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
  ingress: ReturnType<typeof ingressInput>, closing: boolean,
  observe = true,
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
  const route = closing
    ? resolveKernelRoute(stores, event, surfaceKey, event.traceId, ports.requests, at, ports.id)
    : resolveAndRecordRoute(stores, event, surfaceKey, event.traceId,
        ports.sink, ports.requests, at, ports.id, observe);
  return { surfaceKey, existing, event: route.event, route, ...ingress };
}

function matchIngress(
  stores: ChannelStores, ports: GatewayRouterPorts, at: number,
  pending: readonly PendingGroup[], resolved: ReturnType<typeof resolveIngress>,
) {
  return Effect.gen(function* () {
    const { route, addressed, existing, input, surfaceKey } = resolved;
    if (route.decision.outcome !== "route" || route.requestExecution.kind === "request")
      return { rows: [], pending } satisfies MatchDecision;
    const record = route.decision.outcome === "route" && route.decision.stage === "surface_default"
      ? stores.automations.get(`granted-direct:${surfaceKey}`)?.record : undefined;
    const records = stores.automations.list().map((entry) => entry.record);
    const userRecords = records.filter((candidate) => candidate.id !== record?.id &&
      !candidate.id.startsWith("granted-direct:"));
    const options = {
      now: at, pending,
      ...(addressed ? { conversation: `session:${existing ?? route.decision.sessionId}` } : {}),
      matchedToday: (automationId: string) => stores.automations.matchedToday(automationId, at),
    };
    let outcome = yield* judgeAndMatch(addressed && record !== undefined
      ? [...userRecords, record] : userRecords, input, options, ports.judge);
    if (!addressed && outcome.route === undefined && outcome.rows.length === 0 &&
        !outcome.pending.some((group) => group.inputs.some((member) => member.eventId === input.eventId)) &&
        record !== undefined) {
      outcome = yield* judgeAndMatch([record], input, options, ports.judge);
    }
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
): NonNullable<PolicyEvaluationInput["message"]> {
  const addressee = addressed ? "bot"
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
  ingress: ReturnType<typeof ingressInput>,
  closingRoute?: NonNullable<MatchDecision["route"]>,
) {
  return Effect.gen(function* () {
    const resolved = resolveIngress(stores, sender, facts, ports, at, ingress, closingRoute !== undefined);
    const { event, route, identities, addressed, surfaceKey } = resolved;
    const outcome: MatchDecision = closingRoute === undefined
      ? yield* matchIngress(stores, ports, at, pending, resolved)
      : { route: closingRoute, rows: [], pending };
    const disposition = projectDisposition(route, outcome, event.id);
    const target = resolveTarget(route, outcome, resolved.existing ?? ports.id(), ports.id);
    const egressBudget = resolveEgressBudget(route, budgets, stores, event.meta?.actor?.actorId, target, at);
    const message = buildMessage(route, identities, addressed, egressBudget);
    const automation = route.decision.outcome === "route" && route.requestExecution.kind !== "request"
      ? outcome.route : undefined;
    return { route, event, target, surfaceKey, message, facts,
      content: automation?.kind === "action" ? JSON.stringify(automation.body)
        : automation?.origin.body ?? facts.render,
      pending: outcome.pending, disposition, decision: outcome.rows[0], automation };
  });
}

/** Replays validate frozen authority but never re-evaluate the automation or append a decision. */
export function replayExternal(stores: ChannelStores,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>, facts: Gateway.IngressFacts,
  ports: GatewayRouterPorts, at: number, budgets: readonly Gateway.SocialBudget[],
  input: ReturnType<typeof ingressInput>) {
  return Effect.gen(function* () {
    const record = stores.automations.decisions(input.input.eventId)[0];
    if (record?.stage === "automation" && record.by.startsWith("automation/"))
      resolveIngress(stores, sender, facts, ports, at, input, false, false);
    const retry = stores.automations.pendingDelivery(input.input.eventId);
    if (retry === undefined) return undefined;
    return yield* externalMessage(stores, sender, facts, ports, at, budgets, [], input, retry);
  });
}
