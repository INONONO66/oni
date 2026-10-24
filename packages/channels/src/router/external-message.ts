import { Effect } from "effect";
import type { ChannelStores } from "./stores.js";
import type { PolicyEvaluationInput } from "@oni/agent";
import { type Gateway, Ingress, resolveTarget as eventTarget, targetKey } from "@oni/protocol";
import { judgeAndMatch } from "../automation/judge.js";
import type { MatchDecision, PendingGroup } from "../automation/matcher.js";
import { type ingressInput, ingressSurfaceKey } from "./automation/input.js";
import { newTraceId } from "../support/trace";
import { webSocketSenderTier } from "./channel-grant";
import { resolveIngressActor } from "./actor-resolver";
import { isAuthorizedTopLevelActor } from "./authority-actor";
import { recordKernelRoute, resolveKernelRoute } from "./routing-resolution";
import { recordAutomationDuplicate } from "./automation/ledger.js";
import type { GatewayRouterPorts } from "./message-ports";
import { evaluateSocialBudget } from "./messaging/social-budget";

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
  facts: Gateway.IngressFacts, ports: GatewayRouterPorts, at: number,
  ingress: ReturnType<typeof ingressInput>,
) {
  const surfaceKey = ingressSurfaceKey(facts);
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
  const route = resolveKernelRoute(stores, event, surfaceKey, event.traceId, ports.requests, at, ports.id,
    ingress.channel);
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
  facts: Gateway.IngressFacts,
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
      content: routedContent(automation, automationGrant, () =>
        promptContent(facts, resolved.existing === undefined, promptSender(route, facts, event, sender))),
      ...(facts.attachments === undefined ? {} : { parts: facts.attachments.map(
        ({ kind, ref, mime, name, durationMs, voice }) => ({
          kind, ref,
          ...(mime === undefined ? {} : { mime }),
          ...(name === undefined ? {} : { name }),
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(voice === undefined ? {} : { voice }),
        }),
      ) }),
      pending: outcome.pending,
      disposition: disposition ?? (automation === undefined && !message.grantTier &&
        outcome.rows[0]?.stage === "automation" ? outcome.rows[0].decision : undefined),
      decision: outcome.rows[0], automation };
  });
}

/** An automation delivers its trigger body (an action as JSON); a direct route delivers the person's prompt. */
function routedContent(
  automation: MatchDecision["route"] | undefined,
  automationGrant: boolean,
  prompt: () => string,
): string {
  if (automation?.kind === "action") return JSON.stringify(automation.body);
  if (automation !== undefined && automationGrant) return automation.origin.body;
  return prompt();
}

/** Who the prompt names as its sender: nobody for a request answer or the WebSocket owner (#1497). */
function promptSender(
  route: ReturnType<typeof resolveIngress>["route"],
  facts: Gateway.IngressFacts,
  event: ReturnType<typeof resolveIngress>["event"],
  sender: Extract<Gateway.IngestSender, { kind: "external" }>,
): string | undefined {
  if (route.requestExecution.kind === "request" || facts.surface === "ws") return undefined;
  return event.meta?.actor?.actorId ?? sender.externalId;
}

/**
 * The prompt a person's message becomes when it reaches the resident directly
 * (an automation keeps its trigger body): a `[from …]` line naming the
 * contact, channel and message id a reply or reaction is addressed to (#1497;
 * none for a request answer, which the kernel reads as the answer itself, or
 * for the WebSocket owner, who reads the turn stream), the thread's earlier
 * messages once, when the thread's session starts, and a quoted message every time.
 */
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
    `[from ${from} on ${facts.surface} · channel ${facts.channelId} · message ${facts.eventId}${threadId === undefined ? "" : ` · thread ${threadId}`}]`,
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

/** Replays retain the frozen route; completed deliveries append only a dedupe observation. */
export function replayExternal(stores: ChannelStores,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>, facts: Gateway.IngressFacts,
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
