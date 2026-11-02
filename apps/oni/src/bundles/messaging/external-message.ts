import { routeRule, type MatchDecision } from "./rule-outcome.js";
import { recordIngressRoute } from "../../composition/ingress-route.js";
import { Effect } from "effect";
import type { ChannelStores } from "@oni/channels";
import type { PolicyEvaluationInput } from "@oni/agent";
import { type Gateway, Ingress } from "@oni/protocol";
import { type PendingGroup } from "@oni/channels";
import { type ingressInput, ingressSurfaceKey } from "./automation/input.js";
import { match } from "@oni/channels";
import { inboundIdOf as inboundEventId } from "./inbound-id.js";
import { newTraceId } from "@oni/channels";
import { resolveIngressActor } from "./actor-resolver.js";
import { resolveKernelRoute } from "./routing-resolution.js";
import { recordAutomationDuplicate } from "../../composition/ingress-ledger.js";
import type { GatewayRouterPorts } from "./message-ports.js";
import { evaluateSocialBudget } from "./social-budget.js";

function resolveIngress(stores: ChannelStores, sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  facts: Ingress.Message, ports: GatewayRouterPorts, at: number) {
  const surfaceKey = ingressSurfaceKey(facts, sender.externalId);
  const existing = stores.surfaceKeys.lookup(surfaceKey);
  const reply = facts.reply ?? { chain: [] };
  const event = resolveIngressActor(stores, {
    id: inboundEventId(facts), traceId: newTraceId(ports.id), surface: facts.surface,
    ...(facts.workspaceId === undefined ? {} : { workspace: facts.workspaceId }),
    channel: facts.channelId, userId: sender.externalId, payload: facts.payload,
    mode: "direct", meta: { surfaceKey, correlation: {
      ...reply, endpointId: stores.actors.resolveEndpoint(sender.surface, sender.externalId, facts.workspaceId)?.endpoint.id ?? `${sender.surface}:${sender.externalId}`,
      channelId: facts.channelId, externalConversationId: reply.externalConversationId ?? surfaceKey,
    } },
  });
  return { surfaceKey, existing, event, route: resolveKernelRoute(event, ports.requests, at) };
}

/** The first rule alone controls delivery; no match records the inbound without preparing a session. */
export function externalMessage(
  stores: ChannelStores, sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  facts: Ingress.Message, ports: GatewayRouterPorts, at: number,
  budgets: readonly Gateway.SocialBudget[], pending: readonly PendingGroup[],
  ingress: ReturnType<typeof ingressInput>, closingRoute?: NonNullable<MatchDecision["route"]>,
) {
  return Effect.gen(function* () {
    const resolved = resolveIngress(stores, sender, facts, ports, at);
    const { event, surfaceKey, existing } = resolved;
    const request = resolved.route.decision.stage === "request_correlation";
    const outcome = yield* selectRule(stores, ports, ingress, at, pending, request, closingRoute);
    const selected = outcome.route;
    const target = request ? resolved.route.decision.sessionId ?? ports.id()
      : destination(selected, existing, ports.id);
    const automation = selectedAutomation(selected, existing);
    const admitted = request || automation !== undefined;
    const granted = request ? resolved.route : resolveKernelRoute(event, ports.requests, at, automation, target);
    const route = closingRoute === undefined ? recordIngressRoute(stores, granted, ports.sink, at, granted.decision.stage !== "automation") : granted;
    const egressBudget = request || budgetAllows(stores, budgets, event, target, at);
    const message = policyMessage(ingress, route.decision, admitted, egressBudget);
    return { route, event, target, surfaceKey, message, facts, automation,
      content: matchedContent(automation, facts, existing === undefined,
        request || facts.surface === "ws" ? undefined : event.meta?.actor?.actorId ?? sender.externalId),
      ...(facts.attachments === undefined ? {} : { parts: facts.attachments.map(({ bytes: _bytes, ...part }) => part) }),
      pending: outcome.pending, decision: outcome.rows[0],
      disposition: admitted ? undefined : outcome.rows[0]?.reason ?? "none",
    };
  });
}

/** A conversation-targeted rule opens a session only when the thread has none bound yet. */
function selectedAutomation(selected: MatchDecision["route"], existing: string | undefined) {
  if (selected === undefined) return undefined;
  return { ...selected, newSession: selected.newSession || (selected.conversation && existing === undefined) };
}

/** A closing route is frozen; a request answer matches no rule; otherwise the first admitted rule decides. */
function selectRule(stores: ChannelStores, ports: GatewayRouterPorts, ingress: ReturnType<typeof ingressInput>,
  at: number, pending: readonly PendingGroup[], request: boolean, closingRoute: MatchDecision["route"],
): Effect.Effect<MatchDecision, import("@oni/channels").ChannelError> {
  return Effect.gen(function* () {
    if (closingRoute !== undefined) return { route: closingRoute, rows: [], pending };
    if (request) return { rows: [], pending };
    const records = stores.rules.list().filter((entry) => entry.approved || entry.record.createdBy === "owner").map((entry) => entry.record);
    return routeRule((yield* match(ingress.input, records, ports.judge))?.rule, ingress.input,
      { now: at, pending, matchedToday: (id) => stores.rules.matchedToday(id, at) });
  });
}

function destination(selected: MatchDecision["route"], existing: string | undefined, fresh: () => string) {
  if (selected?.target === "conversation") return existing ?? fresh();
  if (selected?.target.startsWith("session:")) return selected.target.slice("session:".length);
  return fresh();
}

function budgetAllows(stores: ChannelStores, budgets: readonly Gateway.SocialBudget[],
  event: Gateway.DeliveredEvent, target: string, at: number) {
  const budget = budgets.find((candidate) => candidate.targetActorId === event.meta?.actor?.actorId);
  return budget === undefined || evaluateSocialBudget(budget,
    stores.egressBudgets.read(target, budget.targetActorId, at - budget.windowMs), { class: "converse", at }) === "allow";
}

function policyMessage(ingress: ReturnType<typeof ingressInput>, decision: Ingress.RoutingDecisionPayload,
  admitted: boolean, egressBudget: boolean): Extract<NonNullable<PolicyEvaluationInput["message"]>, { sender: "external" }> {
  const addressee = ingress.addressed ? "bot"
    : ingress.identities.some((identity) => identity.trustTier === "owner") ? "owner" : "ambient";
  return {
    sender: "external", addressee,
    ...(decision.trustTier === undefined ? {} : { senderTier: decision.trustTier }),
    identity: admitted, grantTier: decision.outcome === "route",
    egressBudget, eventIdUnique: true, replyCorrelation: decision.outcome !== "ambiguous",
  };
}

function matchedContent(automation: MatchDecision["route"], facts: Ingress.Message, fresh: boolean, from: string | undefined) {
  if (automation?.kind === "action") return JSON.stringify(automation.body);
  return promptContent({ ...facts, render: automation?.kind === "prompt" ? automation.origin.render : facts.render }, fresh, from);
}

/** A sender-controlled field stays on its own bracket line: no line breaks, no closing bracket. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").replaceAll("]", "").trim();
}

/** Seconds under a minute, else minutes and two-digit seconds: `12s`, `1m05s`. */
function playtime(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function attachedLine(attachment: NonNullable<Ingress.Message["attachments"]>[number]): string {
  const label = attachment.voice === true ? "voice"
    : `${attachment.kind}${attachment.name === undefined ? "" : ` ${oneLine(attachment.name)}`}`;
  const length = attachment.durationMs === undefined ? "" : ` ${playtime(attachment.durationMs)}`;
  return `[attached: ${label}${length} → ${oneLine(attachment.ref)}]`;
}

function promptContent(facts: Ingress.Message, freshSession: boolean, from: string | undefined): string {
  const thread = freshSession ? (facts.context?.thread ?? []) : [];
  const quoted = facts.context?.quoted;
  const threadId = facts.reply?.threadId;
  const header = from === undefined ? [] : [
    `[from ${from} on ${facts.instance ?? facts.surface} · channel ${facts.channelId} · message ${facts.eventId}${threadId === undefined ? "" : ` · thread ${threadId}`}]`,
  ];
  const attached = (facts.attachments ?? []).map(attachedLine);
  return [
    ...(header.length + attached.length === 0 ? [] : [[...header, ...attached].join("\n")]),
    ...(thread.length === 0 ? [] : [
      `[earlier in this thread]\n${thread.map((message) => `${message.author}: ${message.text}`).join("\n")}\n[end of thread]`,
    ]),
    ...(quoted === undefined ? [] : [`[replying to ${quoted.author}]\n> ${quoted.text.replaceAll("\n", "\n> ")}`]),
    facts.render,
  ].join("\n\n");
}

/** Replays use the frozen route, never current rule order or a new judge answer. */
export function replayExternal(stores: ChannelStores,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>, facts: Ingress.Message,
  ports: GatewayRouterPorts, at: number, budgets: readonly Gateway.SocialBudget[],
  input: ReturnType<typeof ingressInput>) {
  return Effect.gen(function* () {
    const resolved = resolveIngress(stores, sender, facts, ports, at);
    const fact = stores.decisionFacts.port()?.head(Ingress.routeStreamId(resolved.event));
    const original = fact === undefined ? undefined : Ingress.recordedRoutingDecision(fact.data);
    if (original?.outcome === "route" && original.stage === "surface_default") {
      const actor = resolved.event.meta?.actor;
      const { actorId: _actorId, trustTier: _trustTier, inboundTreatment: _treatment, ...recorded } = original;
      const treatment = resolved.event.meta?.inboundTreatment;
      recordIngressRoute(stores, { ...resolved.route, decision: { ...recorded,
        ...(actor?.actorId === undefined ? {} : { actorId: actor.actorId }),
        ...(actor?.trustTier === undefined ? {} : { trustTier: actor.trustTier }),
        ...(treatment === undefined ? {} : { inboundTreatment: treatment }),
        factsUsed: original.factsUsed.filter((entry) => entry.startsWith("rule:")),
      } }, ports.sink, at, false);
    }
    const retry = stores.rules.pendingDelivery(input.input.eventId);
    if (retry === undefined) {
      const record = stores.rules.decisions(input.input.eventId)[0];
      if (record !== undefined) recordAutomationDuplicate(stores, ports.sink, { ...record, time: at });
      return undefined;
    }
    return yield* externalMessage(stores, sender, facts, ports, at, budgets, [], input, retry);
  });
}
