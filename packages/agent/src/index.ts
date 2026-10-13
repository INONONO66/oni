// Agent package public API: exactly five namespaces.
export * as Core from "./core";
export * as Bundle from "./bundle";
export * as Model from "./model";
export * as Inspect from "./inspect";
export * as Testing from "./testing";

// Named exports consumed by packages/channels (legal channels -> agent band
// edges), pinned shrink-only by script/check-deps.ts. Do not grow this list;
// retiring it is a separate decision, owned by no lane.
export { decisionFromEvaluation, evaluatePermission } from "./core/gate/match";
export type { PolicyEvaluationInput } from "./core/gate/compile";
export { requireSubAdapter, withStoreTimestamps } from "./core/store/storage/timestamped-store";
export { createDecisionFactPort } from "./core/store/decision";
