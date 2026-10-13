import { testBus, type TestObservationBus } from "./helpers/bus";
import { expect, test } from "bun:test";
import * as SessionHandleStore from "../src/core/store/fence";
import type { LedgerError } from "../src/core/store/errors";
import { KERNEL_POLICY_REGISTRY } from "../src/core/gate/compile";
import type { AnyToolDefinition, LedgerAction, PlainValue, ToolExecutionContext } from "@openomni/protocol";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect";
import { z } from "zod";
import { GenerationHandlers } from "../src/core/composition/compose";
import { CommitFailed, InvocationClosed, ToolBodyFailed, type ExecutionError } from "../src/core/ports/failure";
import { currentInvocation, forkInvocation, requireOpenInvocation, withInvocation, type InvocationFrame } from "../src/core/loop/executor";
import type { ExecutionResult } from "../src/core/loop/executor";
import { GenerationRawSlots, makeSessionGenerations, type GenerationBundle } from "../src/core/session/run";
import { ObservationSink, SessionLayer, ToolCatalog } from "../src/core/ports/ports";
import { projectTools } from "../src/core/loop/tool";
import { createTurnDispatcher } from "../src/plugins/tool";
import { runAgent } from "./helpers/executor";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { effectValue, fiberSessionId, nativeExecutorOptions, nativePolicy } from "./helpers/native-executor";
import { sessionTree as kernelSessionTree } from "./helpers/session-tree";
import { TEST_APPROVAL_POLICY } from "./helpers/approval-policy";

/** Chain oracle over the active isolation's kernel. */
const sessionTree = (sessionId: string) => kernelSessionTree(isolatedLedger().kernel, sessionId);

const context = { sessionId: fiberSessionId, turnId: `${fiberSessionId}:turn` };
const request = (op: string) => ({ kind: "tool", op, intent: {}, effect: { category: "query" } });
const awaitSignal = <A, E>(signal: Deferred.Deferred<A, E>) => Deferred.await(signal).pipe(Effect.timeout("5 seconds"));
const toolFailureResult = z.object({
  phase: z.literal("result"),
  evidence: z.object({ failures: z.array(z.object({ tag: z.string() })) }),
});
const interruptedToolResult = z.object({
  callId: z.string(),
  evidence: z.object({ interrupted: z.boolean() }),
});
function failure<A, E>(exit: Exit.Exit<A, E>): E | undefined {
  return Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
}
function tool(name: string, execute: (input: PlainValue, context: ToolExecutionContext) => Promise<string>): AnyToolDefinition {
  return { name, description: name, category: "query", input: z.object({}), output: z.string(),
    visibility: { model: ["resident"], cell: ["resident"] }, execute,
    render: (_input: PlainValue, output: PlainValue) => String(output) };
}
function bundle(generation: number, definitions: readonly AnyToolDefinition[], bus: TestObservationBus): GenerationBundle {
  const snapshot = SessionHandleStore.generationSnapshot({ generation, revertTo: generation - 1,
    tools: projectTools(definitions).session,
    system: { preset: "bridge", blocks: [] }, policyGeneration: 1 });
  return { id: { sessionId: fiberSessionId, generation }, snapshot, activate: Effect.void,
    layer: Layer.mergeAll(Layer.succeed(ObservationSink, bus), Layer.succeed(GenerationHandlers, KERNEL_POLICY_REGISTRY),
      Layer.succeed(SessionLayer, { snapshot, policy: nativePolicy }), Layer.succeed(ToolCatalog, { definitions })) };
}
function setup(definitions: readonly AnyToolDefinition[], signal?: AbortSignal) {
  return Effect.gen(function* () {
    const options = yield* nativeExecutorOptions();
    const bus = testBus();
    const generations = yield* makeSessionGenerations(bundle(1, definitions, bus));
    const captureScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(captureScope, Exit.void));
    const captured = yield* generations.capture().pipe(Effect.provideService(Scope.Scope, captureScope));
    const dispatcher = yield* captured.provide(createTurnDispatcher({ ...options.identity, actionId: context.turnId,
      ledger: options.ledger, tools: captured.snapshot.tools, toolsGeneration: 1, signal,
      toolsHash: captured.snapshot.toolsHash, systemHash: captured.snapshot.systemHash }, { closeGraceMs: 0, approvalPolicy: TEST_APPROVAL_POLICY }));
    const slots = yield* captured.provide(GenerationRawSlots);
    return { options, bus, generations, captured, dispatcher, captureScope, slots,
      run: captured.provide(dispatcher.execute({ id: "outer", tool: "outer", input: {} }, context)) };
  });
}

function detachedRequestCase(rejectBody: boolean, reason: "settled" | "failed") {
  return isolated(Effect.gen(function* () {
    const ready = yield* Deferred.make<readonly Effect.Effect<PlainValue, ExecutionError>[]>();
    let bodies = 0;
    const fixture = yield* setup([
      tool("outer", async () => {
        const frame = currentInvocation();
        Deferred.doneUnsafe(ready, Exit.succeed([
          frame.executor.run(request("detached"), () => Effect.sync(() => { bodies += 1; return "forbidden"; })).pipe(Effect.as("done")),
          frame.cell.executeCell({ id: "detached-cell", tool: "inner", input: {} }, context).pipe(Effect.as("done")),
        ]));
        if (rejectBody) throw new Error("outer-rejected");
        return "settled";
      }),
      tool("inner", async () => { bodies += 1; return "forbidden"; }),
    ]);
    if (rejectBody)
      expect(yield* fixture.run).toMatchObject({ isError: true, errorKind: "execution_failed", content: "Error: outer-rejected" });
    else expect(yield* fixture.run).toMatchObject({ content: "settled" });
    const pending = yield* awaitSignal(ready);
    const before = sessionTree(fiberSessionId);
    for (const work of pending)
      expect(failure(yield* Effect.exit(work))).toMatchObject({ _tag: "InvocationClosed", tool: "outer", reason });
    expect(bodies).toBe(0);
    expect(sessionTree(fiberSessionId)).toEqual(before);
  }));
}

test("bridge: nested failure in an admitted async body preserves its typed outcome, not AgentFailure", () => isolated(Effect.gen(function* () {
  const observed = yield* Deferred.make<Exit.Exit<ExecutionResult, ExecutionError>>();
  const fixture = yield* setup([tool("outer", async () => {
    const frame = currentInvocation();
    const result = await runAgent(Effect.exit(frame.executor.run(request("nested"), () =>
      Effect.fail(new ToolBodyFailed({ tool: "nested", cause: "nested-outcome" })))));
    Deferred.doneUnsafe(observed, Exit.succeed(result));
    return "handled";
  })]);
  expect(yield* fixture.run).toMatchObject({ content: "handled" });
  const result = yield* awaitSignal(observed);
  expect(failure(result)).toMatchObject({ _tag: "ToolBodyFailed", tool: "nested", cause: "nested-outcome" });
  expect(failure(result)).not.toMatchObject({ _tag: "AgentFailure" });
  const failures = sessionTree(fiberSessionId)
    .filter((action: LedgerAction.Node) => action.kind === "tool")
    .map(effectValue)
    .map((value) => toolFailureResult.safeParse(value))
    .filter((parsed) => parsed.success)
    .flatMap((parsed) => parsed.data.evidence.failures);
  expect(failures.some((entry) => entry.tag === "ToolBodyFailed")).toBe(true);
})));

test("bridge: two concurrent nested calls resolve independently in call order", () => isolated(Effect.gen(function* () {
  const firstEntered = yield* Deferred.make<void>();
  const secondEntered = yield* Deferred.make<void>();
  const first = yield* Deferred.make<string>();
  const second = yield* Deferred.make<string>();
  const secondReplied = yield* Deferred.make<void>();
  const replies: string[] = [];
  const fixture = yield* setup([tool("outer", async () => {
    const frame = currentInvocation();
    const one = runAgent(frame.executor.run(request("one"), () => Deferred.succeed(firstEntered, undefined).pipe(
      Effect.andThen(Deferred.await(first))))).then((result: ExecutionResult) => { replies.push("one"); return result; });
    const two = runAgent(frame.executor.run(request("two"), () => Deferred.succeed(secondEntered, undefined).pipe(
      Effect.andThen(Deferred.await(second))))).then((result: ExecutionResult) => {
        replies.push("two"); Deferred.doneUnsafe(secondReplied, Exit.void); return result;
      });
    const results = await Promise.all([one, two]);
    expect(results).toEqual([{ terminal: "executed", value: "first" }, { terminal: "executed", value: "second" }]);
    return "both";
  })]);
  const running = yield* Effect.forkScoped(fixture.run);
  yield* awaitSignal(firstEntered);
  yield* awaitSignal(secondEntered);
  yield* Deferred.succeed(second, "second");
  yield* awaitSignal(secondReplied);
  expect(replies).toEqual(["two"]);
  yield* Deferred.succeed(first, "first");
  expect(yield* Fiber.join(running)).toMatchObject({ content: "both" });
  expect(replies).toEqual(["two", "one"]);
})));

test("bridge: closing the executor rejects every pending nested request with InvocationClosed", () => isolated(Effect.gen(function* () {
  const closing = new AbortController();
  const enteredOne = yield* Deferred.make<void>();
  const enteredTwo = yield* Deferred.make<void>();
  const replies = yield* Deferred.make<readonly Exit.Exit<ExecutionResult, ExecutionError>[]>();
  const fixture = yield* setup([tool("outer", async () => {
    const frame = currentInvocation();
    const pending = [enteredOne, enteredTwo].map((entered: Deferred.Deferred<void>, index: number) =>
      runAgent(Effect.exit(frame.executor.run(request(`pending-${index}`), () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))))));
    const results = await Promise.all(pending);
    Deferred.doneUnsafe(replies, Exit.succeed(results));
    return "closed";
  })], closing.signal);
  const running = yield* Effect.forkScoped(fixture.run);
  yield* awaitSignal(enteredOne);
  yield* awaitSignal(enteredTwo);
  closing.abort();
  const results = yield* awaitSignal(replies);
  expect(results).toHaveLength(2);
  for (const result of results) expect(failure(result)).toMatchObject({ _tag: "InvocationClosed", tool: "outer", reason: "interrupted" });
  expect(yield* Fiber.join(running)).toMatchObject({ isError: true });
})));

test("bridge: cancel-before-reply interrupts the body and late nested reply performs zero ledger effects", () => isolated(Effect.gen(function* () {
  const closing = new AbortController();
  const entered = yield* Deferred.make<void>();
  const interrupted = yield* Deferred.make<void>();
  const rawSettled = yield* Deferred.make<void>();
  const rejected = yield* Deferred.make<ExecutionError | undefined>();
  const reply = Promise.withResolvers<string>();
  const fixture = yield* setup([
    tool("outer", async () => {
      const frame = currentInvocation();
      const result = await runAgent(Effect.exit(frame.cell.executeCell({ id: "nested", tool: "inner", input: {} }, context)));
      Deferred.doneUnsafe(rejected, Exit.succeed(failure(result)));
      return "cancelled";
    }),
    tool("inner", async (_input: PlainValue, call: ToolExecutionContext) => {
      call.signal.addEventListener("abort", () => { Deferred.doneUnsafe(interrupted, Exit.void); }, { once: true });
      Deferred.doneUnsafe(entered, Exit.void);
      const value = await reply.promise;
      Deferred.doneUnsafe(rawSettled, Exit.void);
      return value;
    }),
  ]);
  yield* Effect.addFinalizer(() => Effect.sync(() => reply.resolve("cleanup")));
  const running = yield* Effect.forkScoped(fixture.captured.provide(fixture.dispatcher.execute(
    { id: "outer", tool: "outer", input: {} }, { ...context, signal: closing.signal },
  )));
  yield* awaitSignal(entered);
  closing.abort();
  yield* awaitSignal(interrupted);
  expect(yield* awaitSignal(rejected)).toMatchObject({ _tag: "InvocationClosed", reason: "interrupted" });
  expect(yield* Fiber.join(running)).toMatchObject({ isError: true });
  const before = sessionTree(fiberSessionId);
  reply.resolve("late");
  yield* awaitSignal(rawSettled);
  yield* Scope.close(fixture.captureScope, Exit.void);
  yield* fixture.slots.awaitSettled.pipe(Effect.timeout("5 seconds"));
  expect(sessionTree(fiberSessionId)).toEqual(before);
  const interruptedResults = before
    .filter((action: LedgerAction.Node) => action.kind === "tool" && effectValue(action).phase === "result")
    .map(effectValue)
    .map((value) => interruptedToolResult.safeParse(value))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
  expect(interruptedResults).toContainEqual({ callId: "outer", evidence: { interrupted: true } });
  expect(before.filter((action: LedgerAction.Node) => action.kind === "tool" && effectValue(action).phase === "result")
    .map(effectValue)).not.toContainEqual(expect.objectContaining({ callId: "nested", terminal: "executed" }));
})));

test("bridge: detached late requests after settle fail with InvocationClosed and execute nothing", () =>
  detachedRequestCase(false, "settled"));

test("bridge: detached late requests after a rejected body fail with InvocationClosed reason failed", () =>
  detachedRequestCase(true, "failed"));

test("bridge: a forked invocation owns its lifetime independently of the body view it was forked from", () => isolated(Effect.gen(function* () {
  const frames = yield* Deferred.make<{ readonly view: InvocationFrame; readonly forked: ReturnType<typeof forkInvocation> }>();
  const fixture = yield* setup([tool("outer", async () => {
    const view = currentInvocation();
    Deferred.doneUnsafe(frames, Exit.succeed({ view, forked: forkInvocation("forked") }));
    return "forked";
  })]);
  expect(yield* fixture.run).toMatchObject({ content: "forked" });
  const { view, forked } = yield* awaitSignal(frames);
  expect(() => withInvocation(view, () => requireOpenInvocation())).toThrow(new InvocationClosed({ tool: "outer", reason: "settled" }));
  expect(withInvocation(forked.frame, () => requireOpenInvocation())).toBe(forked.frame);
  forked.close("failed");
  expect(() => withInvocation(forked.frame, () => requireOpenInvocation())).toThrow(new InvocationClosed({ tool: "forked", reason: "failed" }));
  expect(() => withInvocation(forked.frame, () => forkInvocation("again"))).toThrow(new InvocationClosed({ tool: "forked", reason: "failed" }));
})));

test("bridge: generation-one frame refuses nested dispatch after committed generation-two selection", () => isolated(Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const selected = Promise.withResolvers<void>();
  const observed = yield* Deferred.make<ExecutionError | undefined>();
  let bodies = 0;
  const definitions = [tool("outer", async () => {
    const frame = currentInvocation();
    Deferred.doneUnsafe(entered, Exit.void);
    await selected.promise;
    const before = sessionTree(fiberSessionId);
    const result = await runAgent(Effect.exit(frame.cell.executeCell({ id: "stale", tool: "inner", input: {} }, context)));
    expect(sessionTree(fiberSessionId)).toEqual(before);
    Deferred.doneUnsafe(observed, Exit.succeed(failure(result)));
    return "old-outer-settled";
  }), tool("inner", async () => { bodies += 1; return "forbidden"; })];
  const fixture = yield* setup(definitions);
  const running = yield* Effect.forkScoped(fixture.run);
  yield* awaitSignal(entered);
  const next = bundle(2, definitions, fixture.bus);
  yield* fixture.generations.configure(next, fixture.options.ledger.commit(SessionHandleStore.configureAction({
    id: "configure-two", sessionId: fiberSessionId, parentId: context.turnId,
    operation: "system.blocks.set", snapshot: next.snapshot, at: 100,
  })).pipe(Effect.mapError((error: LedgerError) => new CommitFailed({ error })))).pipe(
    Effect.ensuring(Effect.sync(() => selected.resolve())),
  );
  expect(yield* awaitSignal(observed)).toMatchObject({ _tag: "GenerationUnavailable", generation: 1 });
  expect(bodies).toBe(0);
  expect(isolatedLedger().kernel.latestGenerationFor(fiberSessionId).generation).toBe(2);
  expect(yield* Fiber.join(running)).toMatchObject({ content: "old-outer-settled" });
  expect(sessionTree(fiberSessionId).filter((action: LedgerAction.Node) => action.kind === "tool" && action.intent.value !== null &&
    typeof action.intent.value === "object" && !Array.isArray(action.intent.value) && action.intent.value.callId === "stale")).toHaveLength(0);
  yield* Scope.close(fixture.captureScope, Exit.void);
})));
