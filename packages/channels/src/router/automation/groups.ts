import { Effect } from "effect";
import { advanceGroups, type MatchDecision } from "../../automation/matcher.js";
import type { StoredGroup } from "../../store/automation/group.js";
import type { ChannelStores } from "../stores.js";
import type { ChannelError } from "../../errors.js";
import type { Gateway } from "@openomni/protocol";

export function advanceAutomationGroups(stores: ChannelStores, now: number,
  dispatch: (group: StoredGroup, route: NonNullable<MatchDecision["route"]>) =>
    Effect.Effect<Gateway.IngestResult, ChannelError>) {
  return Effect.gen(function* () {
    yield* stores.automations.ready;
    for (const group of stores.automations.groups()) {
      const record = stores.automations.get(group.pending.automationId)?.record;
      const closed = advanceGroups(record === undefined ? [] : [record], [group.pending], now);
      if (closed.decisions.length === 0) continue;
      const route = closed.decisions[0]?.route;
      const limited = record?.limits !== undefined &&
        stores.automations.matchedToday(record.id, now) >= record.limits.maxRunsPerDay;
      const result = route === undefined || limited ? undefined : yield* dispatch(group, route);
      stores.automations.closeGroup(group.id, now, result?.status === "executed");
    }
  });
}
