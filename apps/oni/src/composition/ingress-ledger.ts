import { type Gateway, Ingress } from "@oni/protocol";
import { Effect } from "effect";
import { decodeChannelFailure } from "@oni/channels";
import type { StoredGroup } from "@oni/channels";
import type { externalMessage } from "./external-message.js";
import type { GatewayRouterPorts } from "../bundles/message-ports.js";
import type { ChannelStores } from "@oni/channels";

type External = Effect.Success<ReturnType<typeof externalMessage>>;

export function recordAutomationDuplicate(stores: ChannelStores, sink: GatewayRouterPorts["sink"],
  original: Ingress.RoutingDecisionPayload) {
  if (original.stage !== "automation" ||
      (original.decision !== "matched" && original.decision !== "superseded" && original.decision !== "deduped"))
    return;
  const deduped = { ...original, decision: "deduped" as const, reason: "event_id_dedupe" };
  stores.rules.record(deduped);
  sink(Ingress.Events.RoutingDecision, deduped);
}

export function automationReplay(stores: ChannelStores, eventId: string): Gateway.IngestResult | undefined {
  const recorded = stores.rules.decisions(eventId)[0];
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
  const previous = stores.rules.groups().find((group) =>
    group.pending.inputs[0]?.eventId === pending.inputs[0]?.eventId);
  const outcome = stores.rules.get(pending.ruleId)?.record.outcome;
  const target = outcome?.kind === "deliver" ? outcome.target : undefined;
  return {
    id: JSON.stringify([pending.ruleId, pending.key, pending.inputs[0]?.eventId]),
    target: previous?.target ?? (target === "new" ? `session:${ports.id()}` : target === "conversation" ? `session:${external.target}` : target ?? `session:${external.target}`),
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
      stores.rules.record(decision, group, route);
      ports.sink(Ingress.Events.RoutingDecision, decision);
    },
    catch: decodeChannelFailure("automation.record"),
  });
}
