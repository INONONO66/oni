import { type Gateway, Ingress } from "@openomni/protocol";
import { Effect } from "effect";
import { decodeChannelFailure } from "../../errors.js";
import type { StoredGroup } from "../../store/automation/group.js";
import type { externalMessage } from "../external-message.js";
import type { GatewayRouterPorts } from "../message-ports.js";
import type { ChannelStores } from "../stores.js";

type External = Effect.Success<ReturnType<typeof externalMessage>>;

export function automationReplay(stores: ChannelStores, eventId: string): Gateway.IngestResult | undefined {
  const recorded = stores.automations.decisions(eventId)[0];
  if (recorded?.stage !== "automation") return undefined;
  switch (recorded.decision) {
    case "matched":
    case "superseded":
    case "deduped":
      return { status: "blocked_pre", reasonCode: "message.external.event_id_dedupe" };
    case "filtered":
      return { status: "blocked_pre", reasonCode: recorded.by.startsWith("rule/") ? recorded.reason : "filtered" };
    case "grouped":
    case "refused":
      return { status: "blocked_pre", reasonCode: recorded.reason };
  }
}

function heldGroup(stores: ChannelStores, ports: GatewayRouterPorts,
  external: External, sender: Extract<Gateway.IngestSender, { kind: "external" }>): StoredGroup | undefined {
  const pending = external.pending.find((group) =>
    group.inputs.some((member) => member.eventId === external.event.id));
  if (pending === undefined) return undefined;
  const previous = stores.automations.groups().find((group) =>
    group.pending.inputs[0]?.eventId === pending.inputs[0]?.eventId);
  const target = stores.automations.get(pending.automationId)?.record.target;
  return {
    id: JSON.stringify([pending.automationId, pending.key, pending.inputs[0]?.eventId]),
    target: previous?.target ?? (target === "new" ? `session:${ports.id()}` : target ?? `session:${external.target}`),
    pending, sender, facts: external.facts,
  };
}

/** The automation ledger is the only writer of automation decisions and group snapshots. */
export function recordAutomation(stores: ChannelStores, ports: GatewayRouterPorts,
  external: External, sender: Extract<Gateway.IngestSender, { kind: "external" }>, refusal?: string) {
  return Effect.try({
    try: () => {
      const row = external.decision;
      if (row?.stage !== "automation") return;
      const group = heldGroup(stores, ports, external, sender);
      const decision: Ingress.RoutingDecisionPayload = {
        ...row,
        ...(refusal === undefined ? {} : { decision: "refused", reason: refusal }),
        ...(external.automation === undefined ? {} : { target: `session:${external.target}` }),
        ...(group === undefined ? {} : { factsUsed: [...row.factsUsed, `group:${group.id}`] }),
      };
      const route = refusal === undefined && external.automation !== undefined
        ? { ...external.automation, target: `session:${external.target}` } : undefined;
      stores.automations.record(decision, group, route);
      ports.sink(Ingress.Events.RoutingDecision, decision);
    },
    catch: decodeChannelFailure("automation.record"),
  });
}
