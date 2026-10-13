import { Ingress } from "@openomni/protocol";
import { Effect } from "effect";
import { AutomationConfigurationError, AutomationEnableRefused } from "../../errors.js";
import { compiledPattern } from "../../automation/regex.js";
import type { StoredGroup } from "./group.js";
import type { MatchDecision } from "../../automation/matcher.js";

export { AutomationEnableRefused } from "../../errors.js";

export interface StoredAutomation {
  readonly record: Ingress.Automation;
  readonly approved: boolean;
}

export interface AutomationAdapter {
  get(id: string): StoredAutomation | undefined;
  set(entry: StoredAutomation): void;
  remove(id: string): boolean;
  list(): StoredAutomation[];
  record(decision: Ingress.RoutingDecisionPayload, group?: StoredGroup, route?: MatchDecision["route"]): void;
  decisions(inboundId: string): Ingress.RoutingDecisionPayload[];
  pendingDelivery(inboundId: string): MatchDecision["route"];
  completeDelivery(inboundId: string): void;
  groups(): StoredGroup[];
  closeGroup(id: string, at: number, matched: boolean,
    decisions: readonly Ingress.RoutingDecisionPayload[]): Ingress.RoutingDecisionPayload[];
  matchedSince(id: string, start: number, end: number): number;
}

export function createAutomationStore(source: { readonly automation?: AutomationAdapter }) {
  function adapter(): AutomationAdapter {
    if (source.automation === undefined) {
      throw new AutomationConfigurationError({ reason: "store_unconfigured" });
    }
    return source.automation;
  }
  return {
    ready: Effect.suspend(() => source.automation === undefined
      ? Effect.fail(new AutomationConfigurationError({ reason: "store_unconfigured" }))
      : Effect.void),
    add(record: Ingress.Automation, approved = false): StoredAutomation {
      const entry = { record: Ingress.Automation.parse(record), approved };
      for (const pattern of entry.record.conditions?.regex ?? []) compiledPattern(pattern);
      if (entry.record.enabled && entry.record.createdBy !== "owner" && !approved) {
        throw new AutomationEnableRefused({ reason: "approval_required", id: entry.record.id });
      }
      adapter().set(entry);
      return entry;
    },
    get: (id: string) => adapter().get(id),
    list: () => adapter().list(),
    remove: (id: string) => adapter().remove(id),
    enable(id: string): StoredAutomation {
      const entry = adapter().get(id);
      if (entry === undefined) throw new AutomationEnableRefused({ reason: "not_found", id });
      if (entry.record.createdBy !== "owner" && !entry.approved) {
        throw new AutomationEnableRefused({ reason: "approval_required", id });
      }
      const enabled = { ...entry, record: { ...entry.record, enabled: true } };
      adapter().set(enabled);
      return enabled;
    },
    disable(id: string): StoredAutomation {
      const entry = adapter().get(id);
      if (entry === undefined) throw new AutomationEnableRefused({ reason: "not_found", id });
      const disabled = { ...entry, record: { ...entry.record, enabled: false } };
      adapter().set(disabled);
      return disabled;
    },
    approve(id: string): StoredAutomation {
      const entry = adapter().get(id);
      if (entry === undefined) throw new AutomationEnableRefused({ reason: "not_found", id });
      const approved = { ...entry, approved: true };
      adapter().set(approved);
      return approved;
    },
    migrateGrantedDirect(input: {
      readonly surfaceKey: string;
      readonly surface: string;
      readonly channelId: string;
      readonly sessionId: string;
    }): Ingress.Automation {
      const id = `granted-direct:${input.surfaceKey}`;
      const record = Ingress.Automation.parse({
        id, name: "Granted direct", enabled: true, createdBy: "owner",
        triggers: [
          { type: "message", surface: input.surface, event: "message" },
          { type: "message", surface: input.surface, event: "mention" },
        ],
        conditions: { channels: [input.channelId], includeBots: false },
        target: `session:${input.sessionId}`, kind: "prompt",
      });
      const previous = adapter().get(id);
      if (previous?.record.target !== record.target || previous.record.enabled !== record.enabled ||
          JSON.stringify(previous.record.conditions) !== JSON.stringify(record.conditions)) {
        adapter().set({ record, approved: true });
      }
      return record;
    },
    record: (decision: Ingress.RoutingDecisionPayload, group?: StoredGroup, route?: MatchDecision["route"]) =>
      adapter().record(decision, group, route),
    decisions: (inboundId: string) => adapter().decisions(inboundId),
    pendingDelivery: (inboundId: string) => adapter().pendingDelivery(inboundId),
    completeDelivery: (inboundId: string) => adapter().completeDelivery(inboundId),
    groups: () => adapter().groups(),
    closeGroup: (id: string, at: number, matched: boolean,
      decisions: readonly Ingress.RoutingDecisionPayload[]) => adapter().closeGroup(id, at, matched, decisions),
    matchedToday(id: string, at: number): number {
      const start = Math.floor(at / 86_400_000) * 86_400_000;
      return adapter().matchedSince(id, start, start + 86_400_000);
    },
  };
}
