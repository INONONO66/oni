import { runAgent, runAgentSync } from "./helpers/executor";
import { KERNEL_POLICY_REGISTRY } from "../src/core/gate/compile";
import { catalogLayer } from "./helpers/service-layers";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "bun:test";
import { stringQueryTool, valueTool } from "./helpers/query-tool";
import { compilePolicySnapshot, type CompiledPolicySnapshot } from "../src/core/gate/compile";
import type { LedgerAction } from "@oni/protocol";
import { createDispatcher } from "../src/plugins/tool";
import { allowAllPolicy as allowAll, opPhaseOf } from "./helpers/compiled-policy";
import { turnExecutor } from "./helpers/effect-g1";
import { isolated } from "./helpers/isolated";

const denyPre = compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY, generation: 1, mandatory: [], rows: [{
  name: "compaction", kind: "tool", phase: "pre", match: { encodingVersion: 1, value: { op: "echo" } },
  verdict: { encodingVersion: 1, value: { type: "deny", reason: "not_allowed" } }, priority: 1, generation: 1,
}] });
function echoTool(onRun: () => void) {
  return valueTool({ name: "echo", description: "Echo input", execute: async (value) => { onRun(); return value; } });
}
function durableExecutor(policy: CompiledPolicySnapshot, committed?: LedgerAction.Append[]) { return turnExecutor(policy, committed).executor; }
function deniedDispatcher(executions: { count: number }) { return runAgentSync(createDispatcher({ executor: durableExecutor(denyPre) }).pipe(Effect.provide(catalogLayer([echoTool(() => { executions.count += 1; })])))); }
const call = { id: "call-1", tool: "echo", input: { value: "secret" } };
const context = { sessionId: "session-1", turnId: "turn-1" };

describe("compiled tool.pre denial", () => {
  it("normalizes noncanonical numeric tool results without rejecting", async () => isolated(Effect.gen(function* () {
    const result = yield* durableExecutor(allowAll).run({ kind: "tool", op: "number", intent: {}, effect: {} }, () => Effect.succeed(Number.POSITIVE_INFINITY));
    expect(result).toMatchObject({ terminal: "executed", value: null });
  })));
  it("returns an error result through the model door without running the body", async () => isolated(Effect.gen(function* () {
    const executions = { count: 0 };
    const result = yield* deniedDispatcher(executions).execute(call, context);
    expect(executions.count).toBe(0);
    expect(result).toMatchObject({ isError: true, errorKind: "precondition_failed" });
  })));
  it("throws through the cell door without running the body", async () => isolated(Effect.gen(function* () {
    const executions = { count: 0 };
    const exit = yield* Effect.exit(deniedDispatcher(executions).executeCell(call, context));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(Cause.squash(exit.cause)).toMatchObject({ name: "ToolRefused", errorKind: "precondition_failed" });
    expect(executions.count).toBe(0);
  })));
});

describe("cell-door executor propagation", () => {
  it("inherits the enclosing executor so nested cell tools commit durably", async () => isolated(Effect.gen(function* () {
    const committed: LedgerAction.Append[] = [];
    const executor = durableExecutor(allowAll, committed);
    const inner = runAgentSync(createDispatcher().pipe(Effect.provide(catalogLayer([echoTool(() => undefined)]))));
    const outer = runAgentSync(createDispatcher({ executor }).pipe(Effect.provide(catalogLayer([stringQueryTool("outer", "Runs a nested cell tool", async () => {
      // Nested dispatch rides the enclosing isolation directly: isolated() calls
      // serialize on one module-level chain, so nesting one inside a running
      // isolated program deadlocks the chain for the whole test process.
      const nested = await runAgent(inner.executeCell({ id: "call-inner", tool: "echo", input: { value: "nested" } }, context));
      return String(nested.structuredContent);
    })]))));
    const result = yield* outer.execute({ id: "call-outer", tool: "outer", input: {} }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("nested");
    expect(committed.filter((action) => action.kind === "tool").map(opPhaseOf).sort()).toEqual(["echo:intent", "echo:result", "outer:intent", "outer:result"]);
  })));
  it("refuses a cell tool that has no enclosing executor at all", async () => isolated(Effect.gen(function* () {
    const exit = yield* Effect.exit(runAgentSync(createDispatcher().pipe(Effect.provide(catalogLayer([echoTool(() => undefined)])))).executeCell({ id: "call-orphan", tool: "echo", input: { value: "x" } }, context));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(Cause.squash(exit.cause)).toMatchObject({ name: "ExecutorContextError", code: "executor_context_missing" });
  })));
});
