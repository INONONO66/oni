import { generationSnapshot } from "../src/core/store/configure";
import { testBus } from "./helpers/bus";
import { expect, test } from "bun:test";

import { createHandlerTable, createPolicyCompiler, KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS } from "../src/core/gate/compile";
import type { LedgerAction, PlainValue, PolicyRow } from "@openomni/protocol";
import { Clock, Effect, Layer } from "effect";
import { z } from "zod";
import { GenerationHandlers } from "../src/core/composition/compose";
import { makeSessionGenerations } from "../src/core/session/run";
import { Entropy, ObservationSink, SessionLayer, ToolCatalog } from "../src/core/ports/ports";
import { defineTool, projectTools } from "../src/core/loop/tool";
import { createTurnDispatcher } from "../src/plugins/tool";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { effectValue, fiberSessionId, nativeExecutorOptions } from "./helpers/native-executor";
import { sessionTree } from "./helpers/session-tree";
import { TEST_APPROVAL_POLICY } from "./helpers/approval-policy";

type SeedRow = Omit<PolicyRow.Row, "generation">;

function policyRow(name: string, verdict: PlainValue, priority = 100): SeedRow {
  return { name, kind: "tool", phase: "pre", priority,
    match: { encodingVersion: 1, value: { op: "demo__echo" } },
    verdict: { encodingVersion: 1, value: verdict } };
}

/**
 * The composed `GenerationHandlers` carries product transformers/obligations
 * alongside the kernel refs (the registry is a generation service, the
 * deleted runtime bundle plane no longer provides it).
 */
function generationFixture(rows: readonly SeedRow[], bodies: PlainValue[]) {
  return Effect.gen(function* () {
    const Input = z.object({ value: z.string(), secret: z.string().optional() });
    const tool = defineTool({
      name: "demo__echo", description: "echo", category: "query", input: Input, output: z.string(),
      visibility: { model: ["resident"], cell: ["resident"] },
      execute: async (input: z.infer<typeof Input>) => { bodies.push(input); return input.value; },
      render: (_input: z.infer<typeof Input>, value: string) => value,
    });
    const registry = createHandlerTable({
      transformers: [...KERNEL_POLICY_REGISTRY.transformers, { name: "demo/replace", apply: (_input: PlainValue, config: PlainValue) => config }],
      obligations: [...KERNEL_POLICY_REGISTRY.obligations, { name: "demo/cap" }],
    });
    const tools = [tool];
    const source = isolatedLedger().catalog.policies;
    const policyGeneration = source.appendGeneration(() => [...SEEDED_POLICY_ROWS, ...rows]);
    const snapshot = generationSnapshot({
      generation: 1, revertTo: 0, policyGeneration, bundles: ["demo"],
      tools: projectTools(tools).session, system: { preset: "", blocks: [] },
    });
    const seed = Layer.mergeAll(
      Layer.succeed(Clock.Clock, yield* Clock.clockWith(Effect.succeed)), Layer.succeed(Entropy, yield* Entropy),
      Layer.succeed(ToolCatalog, { definitions: tools }),
      Layer.succeed(ObservationSink, testBus()),
      Layer.succeed(GenerationHandlers, registry),
    );
    const layer = Layer.effect(SessionLayer, Effect.gen(function* () {
      const composed = yield* GenerationHandlers;
      return { snapshot, policy: createPolicyCompiler({ registry: composed, source }).pin(policyGeneration) };
    })).pipe(Layer.provideMerge(seed));
    const owner = yield* makeSessionGenerations({ id: { sessionId: fiberSessionId, generation: 1 }, snapshot, layer, activate: Effect.void });
    return yield* owner.capture();
  });
}

function dispatch(rows: readonly SeedRow[], bodies: PlainValue[]) {
  return Effect.gen(function* () {
    const options = yield* nativeExecutorOptions();
    const captured = yield* generationFixture(rows, bodies);
    return yield* captured.provide(Effect.gen(function* () {
      const { policy } = yield* SessionLayer;
      const dispatcher = yield* createTurnDispatcher({
        ...options.identity, actionId: options.identity.turnId, ledger: options.ledger,
        tools: captured.snapshot.tools, toolsGeneration: captured.snapshot.generation,
        toolsHash: captured.snapshot.toolsHash,
      }, { approvalPolicy: TEST_APPROVAL_POLICY });
      const result = yield* dispatcher.execute({ id: "call", tool: "demo__echo", input: { value: "original", secret: "secret" } },
        { sessionId: fiberSessionId, turnId: options.identity.turnId });
      return { result, policy };
    }));
  });
}

test("captured registry data resolves custom transforms and obligations alongside kernel refs", () => isolated(Effect.scoped(Effect.gen(function* () {
  const bodies: PlainValue[] = [];
  const { result, policy } = yield* dispatch([
    policyRow("demo/replace-row", { type: "transform", ref: "demo/replace", config: { fields: ["value", "secret"], value: "bundle", secret: "hidden" } }, 300),
    policyRow("demo/redact-row", { type: "transform", ref: "kernel/redact", config: { paths: ["secret"] } }, 200),
    policyRow("demo/cap-row", { type: "obligation", ref: "demo/cap", metric: "fanout", limit: 2 }),
  ], bodies);
  expect(result).toMatchObject({ toolCallId: "call", content: "bundle" });
  expect(bodies).toEqual([{ value: "bundle" }]);
  expect(policy.evaluate({ kind: "tool", phase: "pre", op: "demo__echo", value: {} }).obligations)
    .toEqual([{ ref: "demo/cap", metric: "fanout", limit: 2 }]);
  expect(policy.evaluate({ kind: "turn", phase: "post", op: "continue", value: {} }).obligations)
    .toEqual([{ ref: "kernel/budget-clamp", metric: "continuation", limit: 8 }]);
}))));

test("a transform's non-string declared field entry is skipped at projection; the string fields still rewrite (#1251 r5)", () => isolated(Effect.scoped(Effect.gen(function* () {
  const bodies: PlainValue[] = [];
  const { result } = yield* dispatch([
    policyRow("demo/replace-row", { type: "transform", ref: "demo/replace", config: { fields: ["value", 7], value: "bundle" } }, 300),
  ], bodies);
  expect(result).toMatchObject({ toolCallId: "call", content: "bundle" });
  expect(bodies).toEqual([{ value: "bundle", secret: "secret" }]);
}))));

for (const type of ["transform", "obligation"] as const) {
  test(`unresolved ${type} ref denies at pinned pre before a tool body runs`, () => isolated(Effect.scoped(Effect.gen(function* () {
    const bodies: PlainValue[] = [];
    const verdict: PlainValue = type === "transform" ? { type, ref: "demo/missing" }
      : { type, ref: "demo/missing", metric: "fanout", limit: 2 };
    const { result, policy } = yield* dispatch([policyRow("demo/missing-row", verdict)], bodies);
    expect(result).toMatchObject({ toolCallId: "call", id: "call", isError: true, errorKind: "precondition_failed" });
    expect(bodies).toEqual([]);
    expect(policy.evaluate({ kind: "tool", phase: "pre", value: {} })).toMatchObject({
      verdict: "deny", reason: "unknown_ref", error: { code: "unknown_ref", ref: "demo/missing" },
    });
    const tree = sessionTree(isolatedLedger().kernel, fiberSessionId);
    const decisions = tree.filter((action: LedgerAction.Node) => action.kind === "policy.decision");
    expect(decisions.map(effectValue)).toMatchObject([{ terminal: "blocked_pre", reason: "unknown_ref" }]);
    expect(tree.filter((action: LedgerAction.Node) => action.kind === "tool")).toEqual([]);
  }))));
}
