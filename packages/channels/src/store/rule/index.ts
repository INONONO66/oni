import { Ingress } from "@oni/protocol";
import { Effect } from "effect";
import { RuleConfigurationError, RuleEnableRefused } from "../../errors.js";
import type { StoredGroup } from "./group.js";
import type { MatchDecision } from "../../automation/matcher.js";

export { RuleEnableRefused } from "../../errors.js";

export interface StoredRule {
  readonly record: Ingress.Rule;
  readonly approved: boolean;
}

export interface RuleAdapter {
  get(id: string): StoredRule | undefined;
  set(entry: StoredRule): void;
  remove(id: string): boolean;
  list(): StoredRule[];
  move(id: string, position: number): StoredRule;
  record(decision: Ingress.RoutingDecisionPayload, group?: StoredGroup, route?: MatchDecision["route"]): void;
  decisions(inboundId: string): Ingress.RoutingDecisionPayload[];
  ledger(query: Ingress.RuleLedgerFilter): Ingress.RoutingDecisionPayload[];
  delivered(inboundId: string, sessionId: string, actionSeq: number): void;
  /** A matched event whose delivery the app refused; the delivery is terminal, never retried. */
  refused(inboundId: string, reason: string): void;
  pendingDelivery(inboundId: string): MatchDecision["route"];
  completeDelivery(inboundId: string): void;
  groups(): StoredGroup[];
  closeGroup(id: string, at: number, matched: boolean,
    decisions: readonly Ingress.RoutingDecisionPayload[]): Ingress.RoutingDecisionPayload[];
  matchedSince(id: string, start: number, end: number): number;
}

export function createRuleStore(source: { readonly rule?: RuleAdapter }) {
  function adapter(): RuleAdapter {
    if (source.rule === undefined) {
      throw new RuleConfigurationError({ reason: "store_unconfigured" });
    }
    return source.rule;
  }
  return {
    ready: Effect.suspend(() => source.rule === undefined
      ? Effect.fail(new RuleConfigurationError({ reason: "store_unconfigured" }))
      : Effect.void),
    add(record: Ingress.Rule, approved = false): StoredRule {
      const entry = { record: Ingress.Rule.parse(record), approved };
      if (adapter().get(record.id)?.record.seed === true && entry.record.seed !== true)
        throw new RuleEnableRefused({ reason: "seed_protected", id: record.id });
      if (entry.record.enabled && entry.record.createdBy !== "owner" && !approved) {
        throw new RuleEnableRefused({ reason: "approval_required", id: entry.record.id });
      }
      adapter().set(entry);
      return entry;
    },
    get: (id: string) => adapter().get(id),
    list: () => adapter().list(),
    remove(id: string): boolean {
      if (adapter().get(id)?.record.seed === true)
        throw new RuleEnableRefused({ reason: "seed_protected", id });
      return adapter().remove(id);
    },
    move: (id: string, position: number) => adapter().move(id, position),
    enable(id: string): StoredRule {
      const entry = adapter().get(id);
      if (entry === undefined) throw new RuleEnableRefused({ reason: "not_found", id });
      if (entry.record.createdBy !== "owner" && !entry.approved) {
        throw new RuleEnableRefused({ reason: "approval_required", id });
      }
      const enabled = { ...entry, record: { ...entry.record, enabled: true } };
      adapter().set(enabled);
      return enabled;
    },
    disable(id: string): StoredRule {
      const entry = adapter().get(id);
      if (entry === undefined) throw new RuleEnableRefused({ reason: "not_found", id });
      const disabled = { ...entry, record: { ...entry.record, enabled: false } };
      adapter().set(disabled);
      return disabled;
    },
    approve(id: string): StoredRule {
      const entry = adapter().get(id);
      if (entry === undefined) throw new RuleEnableRefused({ reason: "not_found", id });
      const approved = { ...entry, approved: true };
      adapter().set(approved);
      return approved;
    },
    record: (decision: Ingress.RoutingDecisionPayload, group?: StoredGroup, route?: MatchDecision["route"]) =>
      adapter().record(decision, group, route),
    decisions: (inboundId: string) => adapter().decisions(inboundId),
    ledger: (query: Ingress.RuleLedgerFilter) => adapter().ledger(query),
    delivered: (inboundId: string, sessionId: string, actionSeq: number) =>
      adapter().delivered(inboundId, sessionId, actionSeq),
    refused: (inboundId: string, reason: string) => adapter().refused(inboundId, reason),
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
