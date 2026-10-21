import { Cause, Effect } from "effect";
import { advanceGroups, type MatchDecision } from "../../automation/matcher.js";
import type { StoredGroup } from "../../store/automation/group.js";
import type { ChannelStores } from "../stores.js";
import { type ChannelError, decodeChannelFailure } from "../../errors.js";
import { Ingress, type BusEvent, type Gateway } from "@oni/protocol";

function closeRows(group: StoredGroup, decision: MatchDecision, result: Gateway.IngestResult | undefined) {
  return decision.rows.map((row): Ingress.RoutingDecisionPayload => {
    if (row.stage !== "automation") return row;
    const factsUsed = [...row.factsUsed, `group:${group.id}`];
    if (result === undefined) return { ...row, factsUsed };
    if (result.status !== "executed")
      return { ...row, factsUsed, decision: "refused", reason: result.reasonCode };
    return { ...row, factsUsed, target: `session:${result.handle.target}`,
      reason: row.decision === "grouped" ? `firing:${result.handle.messageId}` : row.reason };
  });
}

export function advanceAutomationGroups(stores: ChannelStores, now: number,
  sink: BusEvent.Sink["publish"],
  dispatch: (group: StoredGroup, route: NonNullable<MatchDecision["route"]>) =>
    Effect.Effect<Gateway.IngestResult, ChannelError>) {
  return Effect.gen(function* () {
    yield* stores.automations.ready;
    for (const group of stores.automations.groups()) {
      const record = stores.automations.get(group.pending.automationId)?.record;
      const closed = advanceGroups(record === undefined ? [] : [record], [group.pending], now);
      const decision = closed.decisions[0];
      if (decision === undefined) continue;
      const route = decision.route;
      const limited = record?.limits !== undefined &&
        stores.automations.matchedToday(record.id, now) >= record.limits.maxRunsPerDay;
      const result: Gateway.IngestResult | undefined = limited
        ? { status: "blocked_pre", reasonCode: "limit" }
        : route === undefined ? undefined : yield* Effect.suspend(() => dispatch(group, route)).pipe(
          Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.failCause(cause)
            : Effect.succeed({ status: "blocked_pre" as const, reasonCode: `dispatch:${Cause.pretty(cause)}` })),
        );
      const rows = yield* Effect.try({
        try: () => stores.automations.closeGroup(group.id, now, result?.status === "executed",
          closeRows(group, decision, result)),
        catch: decodeChannelFailure("automation.close"),
      });
      for (const row of rows) sink(Ingress.Events.RoutingDecision, row);
    }
  });
}
