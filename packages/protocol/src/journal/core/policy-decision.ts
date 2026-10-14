/**
 * `policy.decision` — per-point verdict with `consulted` rows and obligation.
 * Single writer: the gate (`packages/agent/src/core/loop/executor.ts`).
 */
import { RowBody, declare } from "../declaration.js";

export const policyDecision = declare("policy.decision", RowBody);
