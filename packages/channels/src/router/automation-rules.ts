import { type Gateway, Ingress } from "@openomni/protocol";
import { matchPerimeterRules, type PerimeterPosture } from "../automation/rules.js";
import type { ChannelStores } from "./stores.js";
import type { GatewayRouterPorts } from "./message-ports.js";

export function filterAutomationRules(
  stores: ChannelStores,
  input: Ingress.Input,
  sink: GatewayRouterPorts["sink"],
  at: number,
  posture?: PerimeterPosture,
): Gateway.IngestResult | undefined {
  const decision = matchPerimeterRules(input, at, posture);
  if (decision === undefined || decision.stage !== "automation") return undefined;
  stores.automations.record(decision);
  sink(Ingress.Events.RoutingDecision, decision);
  return { status: "blocked_pre", reasonCode: decision.reason };
}
