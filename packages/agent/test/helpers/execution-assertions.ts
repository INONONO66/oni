import { expect } from "bun:test";
import type { LedgerAction, Tool } from "@oni/protocol";
import type { AgentResult } from "../../src/core/ports/types";

export function expectFailedToolCommit(result: Tool.Result, committed: readonly LedgerAction.Append[]) {
  expect(result).toMatchObject({ isError: true, errorKind: "execution_failed" });
  expect(committed.filter((action) => action.kind === "tool")).toHaveLength(2);
}

export function expectUncalledBudget(result: AgentResult | Error, calls: number) {
  expect(result).toMatchObject({ code: "agent_stop", reason: "budget" });
  expect(calls).toBe(0);
}
