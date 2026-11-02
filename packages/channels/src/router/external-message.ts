import { Effect } from "effect";
import type { ChannelStores } from "./stores.js";
import type { PolicyEvaluationInput } from "@oni/agent";
import { type Gateway, Ingress } from "@oni/protocol";
import { routeRule, type MatchDecision, type PendingGroup } from "../automation/matcher.js";
import { type ingressInput, ingressSurfaceKey } from "./automation/input.js";
import { match } from "./automation/match.js";
import { inboundIdOf as inboundEventId } from "./inbound-id.js";
import { newTraceId } from "../support/trace";
import { resolveIngressActor } from "./actor-resolver";
import { recordKernelRoute, resolveKernelRoute } from "./routing-resolution";
import { recordAutomationDuplicate } from "./automation/ledger.js";
import type { GatewayRouterPorts } from "./message-ports";
import { evaluateSocialBudget } from "./messaging/social-budget";

function resolveIngress(stores: ChannelStores, sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  facts: Gateway.IngressFacts, ports: GatewayRouterPorts, at: number) {
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
  facts: Gateway.IngressFacts, ports: GatewayRouterPorts, at: number,
  budgets: readonly Gateway.SocialBudget[], pending: readonly PendingGroup[],
  ingress: ReturnType<typeof ingressInput>, closingRoute?: NonNullable<MatchDecision["route"]>,
) {
  return Effect.gen(function* () {
    const resolved = resolveIngress(stores, sender, facts, ports, at);
    const { event, surfaceKey, existing } = resolved;
    const request = resolved.route.decision.stage === "request_correlation";
    const records = stores.rules.list().filter((entry) => entry.approved || entry.record.createdBy === "owner").map((entry) => entry.record);
    const outcome: MatchDecision = closingRoute !== undefined ? { route: closingRoute, rows: [], pending }
      : request ? { rows: [], pending }
      : routeRule(yield* match(records, ingress.input, ports.judge), ingress.input,
        { now: at, pending, matchedToday: (id) => stores.rules.matchedToday(id, at) });
    const selected = outcome.route;
    const target = request ? resolved.route.decision.sessionId ?? ports.id()
      : selected?.target === "conversation" ? existing ?? ports.id()
      : selected?.target.startsWith("session:") ? selected.target.slice("session:".length) : ports.id();
    const automation = selected === undefined ? undefined : {
      ...selected, newSession: selected.newSession || (selected.conversation && existing === undefined),
    };
    const granted = request ? resolved.route : resolveKernelRoute(event, ports.requests, at, automation, target);
    const route = closingRoute === undefined ? recordKernelRoute(stores, granted, ports.sink, at, granted.decision.stage !== "automation") : granted;
    const budget = budgets.find((candidate) => candidate.targetActorId === event.meta?.actor?.actorId);
    const egressBudget = request || budget === undefined || evaluateSocialBudget(budget,
      stores.egressBudgets.read(target, budget.targetActorId, at - budget.windowMs), { class: "converse", at }) === "allow";
    const message: Extract<NonNullable<PolicyEvaluationInput["message"]>, { sender: "external" }> = {
      sender: "external", addressee: ingress.addressed ? "bot" : ingress.identities.some((identity) => identity.trustTier === "owner") ? "owner" : "ambient",
      ...(route.decision.trustTier === undefined ? {} : { senderTier: route.decision.trustTier }),
      identity: request || automation !== undefined, grantTier: route.decision.outcome === "route",
      egressBudget, eventIdUnique: true, replyCorrelation: route.decision.outcome !== "ambiguous",
    };
    return { route, event, target, surfaceKey, message, facts, automation,
      content: automation?.kind === "action" ? JSON.stringify(automation.body)
        : promptContent({ ...facts, render: automation?.kind === "prompt" ? automation.origin.body : facts.render }, existing === undefined, request || facts.surface === "ws" ? undefined : event.meta?.actor?.actorId ?? sender.externalId),
      ...(facts.attachments === undefined ? {} : { parts: facts.attachments.map(({ kind, ref, mime, name, durationMs, voice }) => ({
        kind, ref, ...(mime === undefined ? {} : { mime }), ...(name === undefined ? {} : { name }),
        ...(durationMs === undefined ? {} : { durationMs }), ...(voice === undefined ? {} : { voice }),
      })) }),
      pending: outcome.pending, decision: outcome.rows[0],
      disposition: request || automation !== undefined ? undefined : outcome.rows[0]?.reason ?? "none",
    };
  });
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

function attachedLine(attachment: NonNullable<Gateway.IngressFacts["attachments"]>[number]): string {
  const label = attachment.voice === true ? "voice"
    : `${attachment.kind}${attachment.name === undefined ? "" : ` ${oneLine(attachment.name)}`}`;
  const length = attachment.durationMs === undefined ? "" : ` ${playtime(attachment.durationMs)}`;
  return `[attached: ${label}${length} → ${oneLine(attachment.ref)}]`;
}

function promptContent(facts: Gateway.IngressFacts, freshSession: boolean, from: string | undefined): string {
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
  sender: Extract<Gateway.IngestSender, { kind: "external" }>, facts: Gateway.IngressFacts,
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
      recordKernelRoute(stores, { ...resolved.route, decision: { ...recorded,
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
