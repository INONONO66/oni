// Agent package public API: exactly five namespaces.
export * as Core from "./core";
export * as Bundle from "./bundle";
export * as Inspect from "./inspect";
export * as Testing from "./testing";

// Named export consumed by apps/oni, pinned shrink-only by
// script/check-deps.ts. Do not grow this list.
export type { PolicyEvaluationInput } from "./core/gate/types";
