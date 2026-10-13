import { type Gateway, Ingress } from "@openomni/protocol";
import { matchPerimeterRules } from "../automation/rules.js";
import { inboundIdOf } from "./inbound-id.js";
import type { ChannelStores } from "./stores.js";
import { recordRouteDecided } from "./route-record.js";
import type { GatewayRouterPorts } from "./message-ports.js";

export function filterAutomationRules(
  stores: ChannelStores,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  facts: Gateway.IngressFacts,
  sink: GatewayRouterPorts["sink"],
  at: number,
): Gateway.IngestResult | undefined {
  const inboundId = inboundIdOf(facts);
  const input = Ingress.Input.parse({
    eventId: inboundId, surface: facts.surface, event: facts.event ?? "message",
    channelId: facts.channelId, workspaceId: facts.workspaceId,
    threadId: facts.reply?.threadId,
    author: facts.author ?? { externalId: sender.externalId, isBot: false },
    dm: facts.dm, mentionsBot: facts.addressees.length > 0,
    body: facts.render, receivedAt: at,
  });
  const decision = matchPerimeterRules(input, at);
  if (decision === undefined || decision.stage !== "automation") return undefined;
  const effective = recordRouteDecided(stores, Ingress.routeStreamId({
    surface: facts.surface, workspace: facts.workspaceId, channel: facts.channelId, id: inboundId,
  }), decision, at);
  const replay = stores.automations.decisions(inboundId).length > 0;
  if (replay) {
    stores.automations.record({ ...decision, decision: "deduped", reason: "event_id",
      factsUsed: ["eventId"] });
  } else {
    stores.automations.record(effective);
    sink(Ingress.Events.RoutingDecision, effective);
  }
  return { status: "blocked_pre", reasonCode: decision.reason };
}
