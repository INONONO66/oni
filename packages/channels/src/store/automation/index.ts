import { Ingress } from "@openomni/protocol";
import { Data } from "effect";

export interface StoredAutomation {
  readonly record: Ingress.Automation;
  readonly approved: boolean;
}

export interface AutomationAdapter {
  get(id: string): StoredAutomation | undefined;
  set(entry: StoredAutomation): void;
  remove(id: string): boolean;
  list(): StoredAutomation[];
  record(decision: Ingress.RoutingDecisionPayload): void;
  decisions(inboundId: string): Ingress.RoutingDecisionPayload[];
  matchedSince(id: string, start: number, end: number): number;
}

export class AutomationEnableRefused extends Data.TaggedError("AutomationEnableRefused")<{
  readonly reason: "approval_required" | "not_found";
  readonly id: string;
}> {}

export function createAutomationStore(source: { readonly automation?: AutomationAdapter }) {
  function adapter(): AutomationAdapter {
    if (source.automation === undefined) {
      throw new AutomationEnableRefused({ reason: "not_found", id: "automation store unconfigured" });
    }
    return source.automation;
  }
  return {
    add(record: Ingress.Automation, approved = false): StoredAutomation {
      const entry = { record: Ingress.Automation.parse(record), approved };
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
    record: (decision: Ingress.RoutingDecisionPayload) => adapter().record(decision),
    decisions: (inboundId: string) => adapter().decisions(inboundId),
    matchedToday(id: string, at: number): number {
      const start = Math.floor(at / 86_400_000) * 86_400_000;
      return adapter().matchedSince(id, start, start + 86_400_000);
    },
  };
}
