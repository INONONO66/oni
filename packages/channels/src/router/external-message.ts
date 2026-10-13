import type { ChannelStores } from "./stores.js";
import type { PolicyEvaluationInput } from "@openomni/agent";
import { Channel, type Gateway } from "@openomni/protocol";
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
  stores.actors.registerEndpoint({
    id: `ws:${sender.externalId}`,
    actorId,
    channel: "ws",
    externalId: sender.externalId,
  });
}

function resolveAddressee(
  stores: ChannelStores,
  facts: Gateway.IngressFacts,
): "bot" | "owner" | "ambient" {
  const identities = facts.addressees.flatMap((addressee) => {
    const resolved = stores.actors.resolveEndpoint(
      facts.surface,
      addressee.externalId,
      facts.workspaceId,
    );
    return resolved === undefined ? [] : [resolved.identity];
  });
  if (facts.dm || identities.some((identity) => identity.kind === "resident")) return "bot";
  return identities.some((identity) => identity.trustTier === "owner") ? "owner" : "ambient";
}

/** Only raw driver facts enter this projection; every authority field is resolved here. */
export function externalMessage(
  stores: ChannelStores,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  facts: Gateway.IngressFacts,
  sink: GatewayRouterPorts["sink"],
  at: number,
  budgets: readonly Gateway.SocialBudget[],
  requests: GatewayRouterPorts["requests"],
  id: () => string,
) {
  // The sender/facts surface match is checked once by the caller
  // (router/index.ts resolveExternal) before this projection runs.
  const surfaceKey = Channel.SurfaceKey.fromChannel({
    surface: facts.surface,
    namespace: facts.workspaceId ?? facts.surface,
    kind: facts.dm ? "dm" : "channel",
    id: facts.channelId,
    ...(facts.reply?.threadId === undefined ? {} : { threadId: facts.reply.threadId }),
  });
  const reply = facts.reply ?? { chain: [] };
  admitWebSocketOwner(stores, sender);
  const event = resolveIngressActor(
    stores,
    {
      id: inboundIdOf(facts),
      traceId: newTraceId(id),
      surface: facts.surface,
      ...(facts.workspaceId === undefined ? {} : { workspace: facts.workspaceId }),
      channel: facts.channelId,
      userId: sender.externalId,
      payload: facts.payload,
      mode: "direct",
      meta: {
        surfaceKey,
        correlation: {
          ...reply,
          endpointId:
            stores.actors.resolveEndpoint(sender.surface, sender.externalId, facts.workspaceId)
              ?.endpoint.id ?? `${sender.surface}:${sender.externalId}`,
          channelId: facts.channelId,
          externalConversationId: reply.externalConversationId ?? surfaceKey,
        },
      },
    },
    at,
  );
  const route = resolveAndRecordRoute(
    stores,
    event,
    surfaceKey,
    event.traceId,
    sink,
    requests,
    at,
    id,
  );
  const addressee = resolveAddressee(stores, facts);
  const target = route.decision.sessionId ?? stores.surfaceKeys.lookup(surfaceKey) ?? id();
  const actorId = event.meta?.actor?.actorId;
  const budget = budgets.find((candidate) => candidate.targetActorId === actorId);
  // Table A applies declared peer restrictions to unrelated ingress, without
  // charging a send. Correlated answers retain the existing reply exemption.
  const egressBudget =
    route.requestExecution.kind === "request" ||
    budget === undefined ||
    evaluateSocialBudget(
      budget,
      stores.egressBudgets.read(target, budget.targetActorId, at - budget.windowMs),
      {
        class: "converse",
        at,
      },
    ) === "allow";
  const message: NonNullable<PolicyEvaluationInput["message"]> = {
    sender: "external",
    ...(route.decision.trustTier === undefined ? {} : { senderTier: route.decision.trustTier }),
    addressee,
    identity: route.decision.outcome === "route",
    grantTier:
      route.decision.outcome === "route" &&
      (route.requestExecution.kind === "request" || isAuthorizedTopLevelActor(route.event)),
    egressBudget,
    eventIdUnique: true,
    replyCorrelation: route.decision.outcome !== "ambiguous",
  };
  return { route, event, target, surfaceKey, message, content: facts.render };
}
