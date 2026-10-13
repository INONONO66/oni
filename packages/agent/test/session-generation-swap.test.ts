import { testBus } from "./helpers/bus";
import { sessionTree as kernelSessionTree } from "./helpers/session-tree";
import { testExecutor } from "./helpers/executor";
import { expect, test } from "bun:test";
import * as SessionHandleStore from "../src/core/store/fence";
import type { LedgerError } from "../src/core/store/errors";
import type { AnyToolDefinition, LedgerAction, PlainValue, SessionGeneration } from "@openomni/protocol";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { z } from "zod";
import { CommitFailed, AgentFailure, GenerationUnavailable } from "../src/core/ports/failure";
import { createExecutor } from "../src/core/loop/executor";
import { compiledPolicy } from "./helpers/compiled-policy";
import { makeSessionGenerations, type GenerationBundle } from "../src/core/session/run";
import { type GenerationServices, ObservationSink, SessionLayer, ToolCatalog } from "../src/core/ports/ports";
import { GenerationHandlers } from "../src/core/composition/compose";
import { KERNEL_POLICY_REGISTRY } from "../src/core/gate/compile";
import { executeToolBody } from "../src/core/loop/tool";
import { effectValue, fiberSessionId, nativeExecutorOptions, nativePolicy } from "./helpers/native-executor";
import { projectTools } from "../src/core/loop/tool";
import { createTurnDispatcher } from "../src/plugins/tool";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { TEST_APPROVAL_POLICY } from "./helpers/approval-policy";

/** Chain oracle over the active isolation's kernel. */
const sessionTree = (sessionId: string) => kernelSessionTree(isolatedLedger().kernel, sessionId);

function bundle(generation: number, name: string, finalized: () => void,
  execute: () => Promise<string> = async () => name, policy = nativePolicy): GenerationBundle {
  const definition: AnyToolDefinition = {
    name, description: name, category: "query", input: z.object({}), output: z.string(),
    visibility: { model: ["resident"], cell: [] }, execute,
    render: (_input: PlainValue, output: PlainValue) => String(output),
  };
  const snapshot = SessionHandleStore.generationSnapshot({
    generation, revertTo: generation - 1,
    tools: projectTools([definition]).session,
    system: { preset: name, blocks: [] }, policyGeneration: 1,
  });
  return { id: { sessionId: fiberSessionId, generation }, snapshot, activate: Effect.void, layer: Layer.mergeAll(
    Layer.succeed(ObservationSink, testBus()),
    Layer.succeed(GenerationHandlers, KERNEL_POLICY_REGISTRY),
    Layer.succeed(SessionLayer, { snapshot, policy }),
    Layer.succeed(ToolCatalog, { definitions: [definition] }),
    Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(finalized))),
  ) };
}
function selectAction(snapshot: SessionGeneration.Snapshot) {
  return SessionHandleStore.configureAction({
    id: `generation:${snapshot.generation}`, sessionId: fiberSessionId,
    parentId: `${fiberSessionId}:turn`, operation: "system.blocks.set", snapshot, at: 100,
  });
}

const capturedBody = Effect.gen(function* () {
  const { snapshot } = yield* SessionLayer;
  const { definitions } = yield* ToolCatalog;
  const definition = definitions[0];
  if (definition === undefined) return yield* Effect.die("missing captured tool");
  const output = yield* executeToolBody(definition, {}, {
    sessionId: fiberSessionId, turnId: `${fiberSessionId}:turn`, callId: snapshot.systemValue,
    signal: new AbortController().signal,
  }, undefined);
  const stillCaptured = yield* SessionLayer;
  return { generation: stillCaptured.snapshot.generation, system: stillCaptured.snapshot.systemValue, output };
});

test("committed configure swaps the next captured Layer; old body and terminal stay A until its finalizer", () => isolated(Effect.scoped(Effect.gen(function* () {
  const options = yield* nativeExecutorOptions();
  const entered = yield* Deferred.make<void>();
  const finishedA = yield* Deferred.make<void>();
  const release = Promise.withResolvers<string>();
  let finalizersA = 0;
  const a = bundle(1, "A", () => { finalizersA += 1; Deferred.doneUnsafe(finishedA, Exit.void); }, async () => {
    Deferred.doneUnsafe(entered, Exit.void);
    return release.promise;
  });
  const b = bundle(2, "B", () => undefined);
  const generations = yield* makeSessionGenerations(a);
  const executeCaptured = Effect.scoped(Effect.gen(function* () {
    const captured = yield* generations.capture();
    const executor = testExecutor({ ...options, identity: {
      ...options.identity, toolsGeneration: captured.snapshot.generation, systemHash: captured.snapshot.systemHash,
    } });
    return yield* captured.provide(executor.run({
      kind: "tool", op: captured.snapshot.systemValue, intent: {}, effect: {},
    }, () => capturedBody));
  }));
  const running = yield* Effect.forkChild(executeCaptured);
  yield* Deferred.await(entered);
  yield* generations.configure(b, options.ledger.commit(selectAction(b.snapshot)).pipe(
    Effect.mapError((error) => new CommitFailed({ error })),
  ));
  expect(SessionHandleStore.latestGeneration(sessionTree(fiberSessionId)).generation).toBe(2);
  expect(finalizersA).toBe(0);
  release.resolve("A-result");
  expect(yield* Fiber.join(running)).toEqual({ terminal: "executed", value: {
    generation: 1, system: "A", output: { status: "success", output: "A-result" },
  } });
  yield* Deferred.await(finishedA);
  expect(finalizersA).toBe(1);
  expect(yield* executeCaptured).toEqual({ terminal: "executed", value: {
    generation: 2, system: "B", output: { status: "success", output: "B" },
  } });
  expect(sessionTree(fiberSessionId).filter((action) =>
    action.kind === "tool" && effectValue(action).phase === "result").map(effectValue))
    .toMatchObject([{ terminal: "executed", result: { generation: 1, system: "A" } },
      { terminal: "executed", result: { generation: 2, system: "B" } }]);
}))));

test("dispatch table stays captured across configure even when the next generation reuses the tool name", () => isolated(Effect.scoped(Effect.gen(function* () {
  const options = yield* nativeExecutorOptions();
  const entered = yield* Deferred.make<void>();
  const retired = yield* Deferred.make<void>();
  const release = Promise.withResolvers<string>();
  const a = bundle(1, "echo", () => { Deferred.doneUnsafe(retired, Exit.void); }, async () => {
    Deferred.doneUnsafe(entered, Exit.void);
    return release.promise;
  });
  const b = bundle(2, "echo", () => undefined, async () => "B");
  const generations = yield* makeSessionGenerations(a);
  const executeCaptured = Effect.scoped(Effect.gen(function* () {
    const captured = yield* generations.capture();
    return yield* captured.provide(Effect.gen(function* () {
      const dispatcher = yield* createTurnDispatcher({
        ...options.identity, actionId: options.identity.turnId, ledger: options.ledger,
        tools: captured.snapshot.tools, toolsGeneration: captured.snapshot.generation,
        toolsHash: captured.snapshot.toolsHash, systemHash: captured.snapshot.systemHash,
      }, { approvalPolicy: TEST_APPROVAL_POLICY });
      return yield* dispatcher.execute({ id: `call-${captured.snapshot.generation}`, tool: "echo", input: {} },
        { sessionId: fiberSessionId, turnId: options.identity.turnId });
    }));
  }));
  const running = yield* Effect.forkScoped(executeCaptured);
  yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"));
  try {
    yield* generations.configure(b, options.ledger.commit(selectAction(b.snapshot)).pipe(
      Effect.mapError((error: LedgerError) => new CommitFailed({ error })),
    ));
    expect(yield* executeCaptured).toMatchObject({ toolCallId: "call-2", content: "B" });
    release.resolve("A");
    expect(yield* Fiber.join(running)).toMatchObject({ toolCallId: "call-1", content: "A" });
    yield* Deferred.await(retired).pipe(Effect.timeout("5 seconds"));
    const results = sessionTree(fiberSessionId).filter((action: LedgerAction.Node) =>
      action.kind === "tool" && effectValue(action).phase === "result");
    expect(results.map(effectValue)).toMatchObject([
      { terminal: "executed", callId: "call-2" },
      { terminal: "executed", callId: "call-1" },
    ]);
    expect(sessionTree(fiberSessionId).filter((action: LedgerAction.Node) =>
      action.kind === "tool" && effectValue(action).phase !== "result")
      .map((action: LedgerAction.Node) => action.intent.value)).toMatchObject([
      { callId: "call-1", toolsGeneration: 1 },
      { callId: "call-2", toolsGeneration: 2 },
    ]);
  } finally {
    release.resolve("A");
  }
}))));

test("unavailable generations fail closed; revert appends a selection", () => isolated(Effect.scoped(Effect.gen(function* () {
  const options = yield* nativeExecutorOptions();
  const a = bundle(1, "A", () => undefined);
  const generations = yield* makeSessionGenerations(a);
  for (const selected of [bundle(2, "B", () => undefined), bundle(3, "A", () => undefined)]) {
    yield* generations.configure(selected, options.ledger.commit(selectAction(selected.snapshot)).pipe(
      Effect.mapError((error) => new CommitFailed({ error })),
    ));
    expect(yield* Effect.result(generations.capture(a))).toMatchObject({ _tag: "Failure", failure: { _tag: "GenerationUnavailable", generation: 1 } });
  }
  const reverted = yield* generations.capture();
  expect(reverted.snapshot).toMatchObject({ generation: 3, revertTo: 2, systemValue: "A" });
  expect(sessionTree(fiberSessionId).filter((action) => action.kind === "session.configure")).toHaveLength(3);
}))));

test("configure denied by the captured pre-policy never acquires or selects the candidate Layer", () => isolated(Effect.scoped(Effect.gen(function* () {
  const options = yield* nativeExecutorOptions();
  const policy = compiledPolicy([{
    name: "configure-denied", generation: 1, kind: "session.configure", phase: "pre", priority: 2000,
    match: { encodingVersion: 1, value: { op: "system.blocks.set" } },
    verdict: { encodingVersion: 1, value: { type: "deny", reason: "configure_denied" } },
  }]);
  const generations = yield* makeSessionGenerations(bundle(1, "A", () => undefined, undefined, policy));
  const captured = yield* generations.capture();
  let candidateAcquisitions = 0;
  const candidate = bundle(2, "B", () => undefined);
  const result = yield* captured.provide(Effect.gen(function* () {
    const executor = yield* createExecutor({ approvalPolicy: TEST_APPROVAL_POLICY, ledger: options.ledger, identity: options.identity });
    return yield* executor.runExisting({ kind: "session.configure", op: "system.blocks.set", intent: { generation: 2 }, effect: {} }, () =>
      generations.configure({ ...candidate, layer: Layer.merge(candidate.layer, Layer.effectDiscard(Effect.sync(() => { candidateAcquisitions += 1; }))) },
        options.ledger.commit(selectAction(candidate.snapshot)).pipe(Effect.mapError((error) => new CommitFailed({ error }))),
      ).pipe(Effect.as({ generation: 2 }), Effect.mapError((error) => new AgentFailure({ operation: "generation.configure", cause: String(error) }))),
    );
  }));
  expect(result).toMatchObject({ terminal: "blocked_pre" });
  expect(candidateAcquisitions).toBe(0);
  expect((yield* generations.capture()).snapshot.generation).toBe(1);
  const tree = sessionTree(fiberSessionId);
  expect(tree.filter((action) => action.kind === "session.configure")).toHaveLength(1);
  const decisions = tree.filter((action) => action.kind === "policy.decision");
  expect(decisions.map((action) => action.intent.value)).toMatchObject([{
    hook: "session.configure.pre", generation: 1, matchedRuleIds: ["configure-denied"], verdict: "deny",
  }]);
  expect(decisions.map(effectValue)).toMatchObject([{
    terminal: "blocked_pre", evidence: { failures: [{ tag: "PolicyDenied", phase: "pre", ruleIds: ["configure-denied"] }] },
  }]);
}))));

for (const corruption of ["system", "tools", "policy"] as const) {
  test(`refuses a corrupt captured ${corruption} pin without substituting the current catalog`, () => isolated(Effect.scoped(Effect.gen(function* () {
    let bodies = 0;
    const original = bundle(1, "A", () => undefined);
    const generations = yield* makeSessionGenerations(original);
    yield* Effect.scoped(Effect.gen(function* () {
      yield* generations.capture();
      yield* generations.configure(bundle(2, "B", () => undefined, async () => { bodies += 1; return "B"; }), Effect.void);
      const snapshot = { ...original.snapshot,
        ...(corruption === "system" ? { systemHash: "corrupt" } : {}),
        ...(corruption === "tools" ? { toolsHash: "corrupt" } : {}),
        ...(corruption === "policy" ? { policyGeneration: 2 } : {}),
      };
      const result = yield* Effect.result(generations.capture({ ...original, snapshot }));
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "AgentFailure", operation: "generation.capture", cause: "snapshot_hash_mismatch" } });
      expect(bodies).toBe(0);
      expect((yield* generations.capture()).snapshot.generation).toBe(2);
    }));
  }))));
}

test("missing historical executable refuses capture instead of adopting the newest catalog", () => isolated(Effect.scoped(Effect.gen(function* () {
  let bodies = 0;
  const current = bundle(2, "B", () => undefined, async () => { bodies += 1; return "B"; });
  const generations = yield* makeSessionGenerations(current);
  const historical = bundle(1, "A", () => undefined);
  const missing = { ...historical, layer: Layer.effectContext<GenerationServices, GenerationUnavailable, never>(Effect.fail(new GenerationUnavailable({ generation: 1 }))) };
  expect(yield* Effect.result(generations.capture(missing))).toMatchObject({ _tag: "Failure", failure: { _tag: "GenerationUnavailable", generation: 1 } });
  expect(bodies).toBe(0);
  expect((yield* generations.capture()).snapshot).toEqual(current.snapshot);
}))));

test("retired generation stays acquired after interrupted fiber until its raw slot actually settles", () => isolated(Effect.scoped(Effect.gen(function* () {
  const options = yield* nativeExecutorOptions();
  const entered = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const release = Promise.withResolvers<string>();
  let finalized = 0;
  const generations = yield* makeSessionGenerations(bundle(1, "A", () => {
    finalized += 1; Deferred.doneUnsafe(closed, Exit.void);
  }, async () => { Deferred.doneUnsafe(entered, Exit.void); return release.promise; }));
  const running = yield* Effect.forkChild(Effect.scoped(Effect.gen(function* () {
    const captured = yield* generations.capture();
    return yield* captured.provide(testExecutor({ ...options, closeGraceMs: 0 }).run({
      kind: "tool", op: "A", intent: {}, effect: {},
    }, () => capturedBody));
  })));
  yield* Deferred.await(entered);
  const b = bundle(2, "B", () => undefined);
  yield* generations.configure(b, options.ledger.commit(selectAction(b.snapshot)).pipe(
    Effect.mapError((error) => new CommitFailed({ error })),
  ));
  yield* Fiber.interrupt(running);
  expect(finalized).toBe(0);
  expect(sessionTree(fiberSessionId).filter((action) =>
    action.kind === "tool" && effectValue(action).phase === "result").map(effectValue))
    .toMatchObject([{ terminal: "outcome_unknown" }]);
  release.resolve("late");
  yield* Deferred.await(closed);
  expect(finalized).toBe(1);
}))));
