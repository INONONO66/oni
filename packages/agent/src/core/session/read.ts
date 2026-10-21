/**
 * Ordered fact reductions over the journal fold, never the observation bus.
 * `fold.checkpoint` is a store-internal accelerator excluded from every model
 * by construction: each model filters on its declared kinds only.
 */
import type { LedgerAction, PlainValue } from "@oni/protocol";
import { attemptUsage, groupUsageByPurpose } from "../observation/metrics";

export const READ_MODELS = Object.freeze([
  "history",
  "decisions",
  "requests",
  "alarms",
  "generations",
  "tree",
  "metrics",
  "control",
  "outbound",
] as const);
export type ReadModel = (typeof READ_MODELS)[number];

function object(value: PlainValue | undefined): Record<string, PlainValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value: PlainValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function base(action: LedgerAction.Node) {
  return { seq: action.ordinal, id: action.id, at: action.ts };
}

const HISTORY_KINDS = Object.freeze([
  "prompt",
  "action",
  "turn",
  "llm",
  "tool",
  "compaction",
] as const);
type HistoryKind = (typeof HISTORY_KINDS)[number];

function isHistoryKind(kind: LedgerAction.Node["kind"]): kind is HistoryKind {
  return (HISTORY_KINDS as readonly string[]).includes(kind);
}

function historyRows(actions: readonly LedgerAction.Node[]) {
  return actions.flatMap((action) => {
    if (!isHistoryKind(action.kind)) return [];
    const intent = object(action.intent.value);
    const effect = object(action.effect.value);
    return [{
      ...base(action),
      kind: action.kind,
      op: text(intent.op),
      phase: text(intent.phase) ?? text(effect.phase),
    }];
  });
}

function decisionRows(actions: readonly LedgerAction.Node[]) {
  return actions.flatMap((action) => {
    if (action.kind !== "policy.decision") return [];
    const intent = object(action.intent.value);
    const effect = object(action.effect.value);
    return [{
      ...base(action),
      hook: text(intent.hook),
      op: text(intent.op),
      verdict: text(intent.verdict),
      reason: text(effect.reason),
      consulted: object(intent.gate).consulted ?? null,
    }];
  });
}

function requestRows(actions: readonly LedgerAction.Node[]) {
  return actions.flatMap((action) => {
    if (action.kind !== "request") return [];
    const intent = object(action.intent.value);
    const effect = object(action.effect.value);
    return [{
      ...base(action),
      requestId: text(intent.requestId) ?? text(object(effect.request).requestId) ?? action.id,
      phase: text(effect.phase),
    }];
  });
}

function alarmRows(actions: readonly LedgerAction.Node[]) {
  return actions.flatMap((action) => {
    if (action.kind !== "alarm") return [];
    const intent = object(action.intent.value);
    return [{
      ...base(action),
      op: text(intent.op),
      purpose: text(intent.purpose),
      occurrenceId: text(intent.occurrenceId),
      outcome: text(intent.outcome),
    }];
  });
}

function generationRows(actions: readonly LedgerAction.Node[]) {
  return actions.flatMap((action) =>
    action.kind === "session.configure"
      ? [{ ...base(action), settings: object(action.intent.value).settings ?? null }]
      : [],
  );
}

function treeRows(actions: readonly LedgerAction.Node[]) {
  return actions.flatMap((action) =>
    action.kind === "session.configure" ? [{ ...base(action), parentId: action.parentId }] : [],
  );
}

function metricsPage(actions: readonly LedgerAction.Node[]) {
  const usage = attemptUsage(actions);
  return {
    usage,
    usageByPurpose: groupUsageByPurpose(actions, usage),
    turns: actions.flatMap((action) => (action.kind === "turn" ? [base(action)] : [])),
  };
}

function controlRows(actions: readonly LedgerAction.Node[]) {
  return actions.flatMap((action) =>
    action.kind === "signal"
      ? [{ ...base(action), control: text(object(action.intent.value).control) }]
      : [],
  );
}

function outboundRows(actions: readonly LedgerAction.Node[]) {
  return actions.flatMap((action) => {
    if (action.kind !== "message") return [];
    const intent = object(action.intent.value);
    return [{ ...base(action), to: text(intent.to), direction: text(intent.direction) }];
  });
}

export function renderReadModel(model: ReadModel, actions: readonly LedgerAction.Node[]) {
  switch (model) {
    case "history":
      return historyRows(actions);
    case "decisions":
      return decisionRows(actions);
    case "requests":
      return requestRows(actions);
    case "alarms":
      return alarmRows(actions);
    case "generations":
      return generationRows(actions);
    case "tree":
      return treeRows(actions);
    case "metrics":
      return metricsPage(actions);
    case "control":
      return controlRows(actions);
    case "outbound":
      return outboundRows(actions);
  }
}
