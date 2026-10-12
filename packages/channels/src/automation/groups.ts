import { Effect } from "effect";
import { advanceGroups, type PendingGroup } from "./matcher.js";
import { deliverAutomation } from "./deliver.js";
import type { ChannelStores } from "../router/stores.js";
import type { GatewayRouterPorts } from "../router/message-ports.js";

function closeDecision(
  stores: ChannelStores, ports: GatewayRouterPorts,
  records: ReturnType<ChannelStores["automations"]["list"]>,
  decision: ReturnType<typeof advanceGroups>["decisions"][number], now: number,
) {
  return Effect.gen(function* () {
    const route = decision.route;
    const record = route?.kind === "action"
      ? records.find((candidate) => candidate.record.id === route.body.automationId)?.record
      : undefined;
    const limited = record?.limits !== undefined &&
      stores.automations.matchedToday(record.id, now) >= record.limits.maxRunsPerDay;
    for (const row of decision.rows) stores.automations.record(limited && row.stage === "automation"
      ? { ...row, decision: "refused", reason: "limit" } : row);
    if (limited || route?.kind !== "action") return;
    const latest = route.body.event.messages.at(-1);
    if (latest === undefined) return;
    const author = route.body.event.author;
    yield* deliverAutomation(ports, {
      kind: "external", surface: route.body.event.surface, externalId: author.externalId,
    }, route, latest.eventId, now, "");
  });
}

/** One gateway instance owns its pending windows; only the injected clock advances them. */
export function createAutomationGroups(stores: ChannelStores, ports: GatewayRouterPorts) {
  let pending: readonly PendingGroup[] = [];
  return {
    current: () => pending,
    update: (next: readonly PendingGroup[]) => { pending = next; },
    advance(now: number) {
      return Effect.gen(function* () {
        if (pending.length === 0) return;
        const records = stores.automations.list();
        const closed = advanceGroups(records.map((entry) => entry.record), pending, now);
        pending = closed.pending;
        for (const decision of closed.decisions) yield* closeDecision(stores, ports, records, decision, now);
      });
    },
  };
}
