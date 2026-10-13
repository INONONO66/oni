
import { testExecutor, runAgentSync } from "../../helpers/executor";
import type { ResolvedExecutorOptions } from "../../../src/core/loop/executor";
import { catalogLayer } from "../../helpers/service-layers";
import { expect, it } from "bun:test";
import { PlainObjectSchema, type LedgerAction, type ToolExecutionContext } from "@openomni/protocol";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { sessionTree as kernelSessionTree } from "../../helpers/session-tree";
import { requestLedger } from "../../helpers/effect-g1";
import { createTestAgent } from "../../helpers/effect-g2";
import { runInput } from "../../helpers/run-input";
import { pendingTimedAssistant, readyWaveTurn } from "../../helpers/tool-wave";
import { fixtureStopEvidence } from "../../helpers/chat-services";
import { settleModelTools } from "../../../src/core/loop/tool";
import type { ObservedChatAgentConfig } from "../../../src/core/ports/types";
import { createRawSlots } from "../../../src/core/loop/executor";
import { GenerationRawSlots } from "../../../src/core/session/run";
import { createDispatcher } from "../../../src/plugins/tool";
import { executeToolBody } from "../../../src/core/loop/tool";
import { AgentFailure } from "../../../src/core/ports/failure";

import { allowAllPolicy } from "../../helpers/compiled-policy";
import { recordingLedger } from "../../helpers/effect-g2";
import { bounded } from "../../helpers/bounded";
import { isolated, isolatedLedger } from "../../helpers/isolated";

/** Chain oracle over the active isolation's kernel. */
const sessionTree = (sessionId: string) => kernelSessionTree(isolatedLedger().kernel, sessionId);
import { timedQueryTool, valueTool } from "../../helpers/query-tool";
import { TEST_BUDGET } from "../../helpers/approval-policy";

const request = { kind: "tool", op: "test", intent: {}, effect: {} };
const call = { id: "timed-call", tool: "timed", input: {} };
const context = { sessionId: "session-1", turnId: "turn-1" };
function recording(overrides: Partial<ResolvedExecutorOptions> = {}) {
  const record = recordingLedger();
  return {
    ...record,
    executor: testExecutor({
      policy: allowAllPolicy,
      ledger: record.ledger,
      observations: { publish: () => undefined },
      identity: { sessionId: "session-1", role: "resident", parentActionId: null },
      clock: () => 1,
      entropy: record.entropy,
      random: () => 0,
      closeGraceMs: 0,
      ...overrides,
    }),
  };
}
function toolResults(actions: readonly LedgerAction.Append[]) {
  return actions.filter((action: LedgerAction.Append) => {
    const value = action.effect.value;
    return action.kind === "tool" && value !== null && typeof value === "object" && !Array.isArray(value) && value.phase === "result";
  });
}

const fallbackTurn = (
  config: ObservedChatAgentConfig,
  onToolResult: (result: { toolCallId: string }) => void = () => undefined,
) => readyWaveTurn(config, context.sessionId, { onMessage: () => undefined, onToolCall: () => undefined, onToolResult });

for (const door of ["cell", "wave"] as const) {
  for (const owner of ["bound", "generation"] as const) {
    it(`fulfills ${owner} ownership after timed ${door} rejection`, () => isolated(Effect.scoped(Effect.gen(function* () {
      const gate = Promise.withResolvers<void>();
      const timedOut = Promise.withResolvers<void>();
      const effects = new Set<Promise<void>>();
      const observers: Promise<void>[] = [];
      const rejectedOwnership: Error[] = [];
      let foreignRetentions = 0;
      let rawSettled = false;
      const retain = (effect: Promise<void>) => {
        effects.add(effect);
        observers.push(effect.then(
          () => { effects.delete(effect); },
          (error: Error) => { rejectedOwnership.push(error); },
        ));
      };
      const generation = createRawSlots(owner === "generation" ? retain : undefined);
      const record = recording(owner === "bound" ? { retainEffect: retain } : {});
      const dispatcher = runAgentSync(createDispatcher({
        executor: record.executor,
        timeoutMs: 0,
        retainEffect: () => { foreignRetentions += 1; },
      }).pipe(Effect.provide(catalogLayer([
        timedQueryTool("actual timed rejection", async (_input: Record<string, never>, execution: ToolExecutionContext) => {
          execution.signal.addEventListener("abort", () => timedOut.resolve(), { once: true });
          await gate.promise;
          rawSettled = true;
          throw new Error("raw definition rejected");
        }),
      ]))));
      const work = Effect.gen(function* () {
        return door === "cell"
          ? [yield* dispatcher.executeCell(call, context)]
          : yield* dispatcher.executeWave([call], context);
      });
      const wrapper = yield* Effect.forkScoped(work.pipe(Effect.provideService(GenerationRawSlots, generation)));
      try {
        yield* Effect.promise(() => bounded(timedOut.promise));
        const results = yield* Fiber.join(wrapper);
        const frozen = structuredClone(results);
        expect(results).toMatchObject([{ isError: true, errorKind: "execution_failed" }]);
        expect(record.committed.at(-1)?.effect.value).toMatchObject({
          terminal: "outcome_unknown", reason: "raw_body_unsettled_after_grace",
        });
        expect(rawSettled).toBe(false);
        expect(foreignRetentions).toBe(0);
        expect(effects.size).toBe(1);
        const actionCount = record.committed.length;
        const pending = [...effects];
        gate.resolve();
        const settlement = yield* Effect.promise(() => bounded(Promise.allSettled(pending)));
        yield* Effect.promise(() => bounded(Promise.all(observers)));
        expect(rawSettled).toBe(true);
        expect(results).toEqual(frozen);
        expect(record.committed).toHaveLength(actionCount);
        expect(settlement.map((result: PromiseSettledResult<void>) => result.status)).toEqual(["fulfilled"]);
        expect(rejectedOwnership).toEqual([]);
        expect(effects.size).toBe(0);
        expect(generation.pending()).toBe(0);
      } finally {
        gate.resolve();
        yield* Fiber.await(wrapper);
        yield* Effect.promise(() => bounded(Promise.all(observers)));
      }
    }))), 15000);
  }

  it(`reports timed ${door} rejection before timeout`, () => isolated(Effect.gen(function* () {
    const record = recording();
    const dispatcher = runAgentSync(createDispatcher({ executor: record.executor, timeoutMs: 0 }).pipe(Effect.provide(catalogLayer([
      timedQueryTool("immediate rejection", async () => { throw new Error("raw definition rejected"); }),
    ]))));
    const results = door === "cell"
      ? [yield* dispatcher.executeCell(call, context)]
      : yield* dispatcher.executeWave([call], context);
    expect(results).toMatchObject([{ isError: true, errorKind: "execution_failed" }]);
    expect(record.committed.at(-1)?.effect.value).toMatchObject({
      terminal: "executed",
      evidence: { failures: [{ tag: "ToolBodyFailed", cause: "Error: raw definition rejected" }] },
    });
  })));

  for (const rejects of [false, true]) {
    it(`inherits generation retention into a timed ${door} definition that ${rejects ? "rejects" : "fulfills"}`, () => isolated(Effect.scoped(Effect.gen(function* () {
      const gate = Promise.withResolvers<void>();
      const timedOut = Promise.withResolvers<void>();
      const generation = createRawSlots();
      const dispatcher = runAgentSync(createDispatcher({ executor: recording().executor, timeoutMs: 0 }).pipe(Effect.provide(catalogLayer([
        timedQueryTool("timed effect", async (_input: Record<string, never>, execution: ToolExecutionContext) => {
          execution.signal.addEventListener("abort", () => timedOut.resolve(), { once: true });
          await gate.promise;
          if (rejects) throw new Error("raw effect rejected");
          return "effect";
        }),
      ]))));
      const wave = yield* Effect.forkScoped(Effect.gen(function* () {
        const results = door === "cell"
          ? [yield* dispatcher.executeCell(call, context)]
          : yield* dispatcher.executeWave([call], context);
        expect(results.map((result: { readonly isError?: boolean }) => result.isError)).toEqual([true]);
      }).pipe(Effect.provideService(GenerationRawSlots, generation)));
      try {
        yield* Effect.promise(() => bounded(timedOut.promise));
        yield* Fiber.join(wave);
        expect(generation.pending()).toBe(1);
        gate.resolve();
        yield* generation.awaitSettled.pipe(Effect.timeout("5 seconds"));
        expect(generation.pending()).toBe(0);
      } finally {
        gate.resolve();
        yield* Fiber.await(wave);
        yield* generation.awaitSettled.pipe(Effect.timeout("5 seconds"));
      }
    }))), 15000);
  }
}

it("inherits raw-body retention through nested executors without a bound turn owner", () => isolated(Effect.scoped(Effect.gen(function* () {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<string>();
  const generation = createRawSlots();
  const outer = recording({ signal: controller.signal });
  const inner = recording({ signal: controller.signal });
  const definition = timedQueryTool("nested raw body", () => {
    entered.resolve();
    return gate.promise;
  });
  const wave = yield* Effect.forkScoped(outer.executor.run(request, () => inner.executor.runBatch([{
    request,
    body: () => executeToolBody(definition, {}, { ...context, callId: call.id, signal: controller.signal }, undefined),
  }], { signal: controller.signal }).pipe(Effect.as(null))).pipe(Effect.provideService(GenerationRawSlots, generation)));
  try {
    yield* Effect.promise(() => bounded(entered.promise));
    controller.abort();
    expect(yield* Fiber.join(wave)).toMatchObject({ terminal: "interrupted" });
    expect(toolResults(inner.committed).map((action: LedgerAction.Append) => action.effect.value)).toMatchObject([
      { terminal: "outcome_unknown", reason: "raw_body_unsettled_after_grace" },
    ]);
    // Only the actual foreign definition owns a raw slot, not its executor wrappers.
    expect(generation.pending()).toBe(1);
  } finally {
    gate.resolve("late");
    yield* Fiber.await(wave);
    yield* generation.awaitSettled.pipe(Effect.timeout("5 seconds"));
  }
}))));

it("freezes unsettled slots as interrupted at the abort event, even if a body resolves in that event", () => isolated(Effect.scoped(Effect.gen(function* () {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<{ late: boolean }>();
  const record = recording();
  const pending = yield* Effect.forkScoped(record.executor.runBatch([{
    request,
    body: () => Effect.promise(() => {
      controller.signal.addEventListener("abort", () => result.resolve({ late: true }), { once: true });
      entered.resolve();
      return result.promise;
    }),
  }], { signal: controller.signal }));
  yield* Effect.promise(() => bounded(entered.promise));
  controller.abort();
  expect(yield* Fiber.join(pending)).toEqual([{ terminal: "interrupted", reason: "fiber_interrupted" }]);
}))));

for (const settlement of ["fulfillment", "rejection"] as const) {
  it(`does not let a late body ${settlement} overwrite cancellation`, () => isolated(Effect.scoped(Effect.gen(function* () {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    const effects: Promise<void>[] = [];
    const record = recording({ retainEffect: (effect: Promise<void>) => { effects.push(effect); } });
    const definition = timedQueryTool("late settlement", () => {
      entered.resolve();
      return release.promise;
    });
    const wave = yield* Effect.forkScoped(record.executor.runBatch([{
      request,
      body: () => executeToolBody(definition, {}, { ...context, callId: call.id, signal: controller.signal }, undefined),
    }], { signal: controller.signal }));
    try {
      yield* Effect.promise(() => bounded(entered.promise));
      controller.abort();
      const results = yield* Fiber.join(wave);
      expect(results).toEqual([{ terminal: "outcome_unknown", reason: "raw_body_unsettled_after_grace" }]);
      const frozen = structuredClone(record.committed);
      expect(effects).toHaveLength(1);
      if (settlement === "rejection") release.reject(new Error("late rejection"));
      else release.resolve("late");
      expect(yield* Effect.promise(() => bounded(Promise.allSettled(effects)))).toEqual([
        { status: "fulfilled", value: undefined },
      ]);
      expect(record.committed).toEqual(frozen);
      expect(yield* Fiber.join(wave)).toEqual(results);
    } finally {
      release.resolve("late");
      yield* Fiber.await(wave);
      yield* Effect.promise(() => bounded(Promise.allSettled(effects)));
    }
  }))));
}

it("preserves input-order results and ledger terminals after reverse body completion", () => isolated(Effect.scoped(Effect.gen(function* () {
  const record = recording();
  const slots = yield* Effect.forEach(["A", "B", "C"], (id) => Effect.gen(function* () {
    return { id, entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>(), settled: yield* Deferred.make<void>() };
  }));
  const completed: string[] = [];
  const wave = yield* Effect.forkScoped(record.executor.runBatch(slots.map((slot) => ({
    request: { ...request, op: slot.id, toolObservation: { turnId: context.turnId, callId: slot.id } },
    body: () => Deferred.succeed(slot.entered, undefined).pipe(
      Effect.andThen(Deferred.await(slot.release)),
      Effect.tap(() => Effect.sync(() => completed.push(slot.id))),
      Effect.as(slot.id),
      Effect.ensuring(Deferred.succeed(slot.settled, undefined)),
    ),
  })), { signal: new AbortController().signal }));
  yield* Effect.forEach(slots, (slot) => Deferred.await(slot.entered)).pipe(Effect.timeout("5 seconds"));
  for (const slot of [...slots].reverse()) {
    yield* Deferred.succeed(slot.release, undefined);
    yield* Deferred.await(slot.settled).pipe(Effect.timeout("5 seconds"));
  }
  expect(yield* Fiber.join(wave)).toEqual(slots.map((slot) => ({ terminal: "executed", value: slot.id })));
  expect(completed).toEqual(["C", "B", "A"]);
  expect(toolResults(record.committed).map((action) => PlainObjectSchema.parse(action.effect.value).callId)).toEqual(["A", "B", "C"]);
}))));

for (const failureKind of ["typed", "defect"] as const) {
  it(`retains siblings' evidence after a ${failureKind} body failure`, () => isolated(Effect.scoped(Effect.gen(function* () {
    const record = recording();
    const siblingEntered = yield* Deferred.make<void>();
    const failed = yield* Deferred.make<void>();
    const failure = new AgentFailure({ operation: "A", cause: "body_failed" });
    const results = yield* record.executor.runBatch([
      { request: { ...request, op: "A" }, body: () => Deferred.await(siblingEntered).pipe(
        Effect.andThen(failureKind === "typed" ? Effect.fail(failure) : Effect.die(new Error("body_defect"))),
        Effect.ensuring(Deferred.succeed(failed, undefined)),
      ) },
      { request: { ...request, op: "B" }, body: () => Deferred.succeed(siblingEntered, undefined).pipe(
        Effect.andThen(Deferred.await(failed)), Effect.as({ sibling: "survived" }),
      ) },
    ], { signal: new AbortController().signal }).pipe(Effect.timeout("5 seconds"));
    expect(results).toMatchObject([
      { terminal: "executed", failure: { _tag: "AgentFailure" } },
      { terminal: "executed", value: { sibling: "survived" } },
    ]);
    const terminals = toolResults(record.committed).map((action) => PlainObjectSchema.parse(action.effect.value));
    expect(terminals).toHaveLength(2);
    expect(terminals[0]?.evidence).toMatchObject(failureKind === "typed"
      ? { failures: [{ tag: "AgentFailure" }], defects: [] }
      : { failures: [], defects: [{ name: "Error" }] });
    expect(terminals[1]?.result).toEqual({ sibling: "survived" });
  }))));
}

it("refuses incomplete arguments without losing valid or invalid input positions", () => isolated(Effect.gen(function* () {
  const bodies: string[] = [];
  const record = recording();
  const definition = valueTool({ name: "value", execute: async (value) => { bodies.push(value); return value; } });
  const dispatcher = yield* createDispatcher({ executor: record.executor }).pipe(Effect.provide(catalogLayer([definition])));
  const results = yield* dispatcher.executeWave([
    { id: "incomplete", tool: "value", input: {} },
    { id: "complete", tool: "value", input: { value: "complete" } },
    { id: "unnamed", tool: "", input: {} },
  ], context);
  expect(results).toMatchObject([
    { toolCallId: "incomplete", isError: true, errorKind: "invalid_input" },
    { toolCallId: "complete", content: "complete" },
    { toolCallId: "unnamed", isError: true, errorKind: "unregistered_tool" },
  ]);
  expect(bodies).toEqual(["complete"]);
  expect(toolResults(record.committed).map((action) => PlainObjectSchema.parse(action.effect.value).callId)).toEqual(["complete"]);
})));

it("holds the entire wave until every captured approval has a durable answer", () => isolated(Effect.scoped(Effect.gen(function* () {
  const opened = yield* Deferred.make<void>();
  let requests = 0;
  const ledger = yield* requestLedger({ onRequest: (request) => {
    if (request.state === "open" && ++requests === 2) Deferred.doneUnsafe(opened, Effect.void);
  } });
  const record = recording({ ...ledger, authorizeApproval: () => Effect.succeed({ kind: "owner", principalId: "owner", evidenceId: "auth" }) });
  const bodies: string[] = [];
  const calls = ["unguarded", "first", "second"];
  const wave = yield* Effect.forkScoped(record.executor.runBatch(calls.map((id) => ({
    request: { ...request, op: id, approval: { required: id !== "unguarded", domainRevisions: {} }, toolObservation: { turnId: ledger.identity.turnId, callId: id } },
    body: () => Effect.sync(() => { bodies.push(id); return id; }),
  })), { signal: new AbortController().signal }));
  yield* Deferred.await(opened).pipe(Effect.timeout("5 seconds"));
  const approvals = record.executor.approvals;
  if (approvals === undefined) throw new Error("missing approval authority");
  const [first, second] = approvals.pending();
  if (first === undefined || second === undefined) throw new Error("missing wave approvals");
  expect(bodies).toEqual([]);
  yield* approvals.answer({ request: second, credential: "owner", decision: "approve" });
  expect(bodies).toEqual([]);
  yield* approvals.answer({ request: first, credential: "owner", decision: "approve" });
  expect(yield* Fiber.join(wave)).toEqual(calls.map((value) => ({ terminal: "executed", value })));
  expect(bodies).toEqual(calls);
  expect(toolResults(sessionTree(ledger.identity.sessionId)).map((action) => PlainObjectSchema.parse(action.effect.value).callId)).toEqual(calls);
}))));

const pendingAssistant = (ids: readonly string[]) => pendingTimedAssistant(context.sessionId, ids);

it("dispatches zero tools when the canonical assistant call-block write fails", () => isolated(Effect.gen(function* () {
  const ledger = recordingLedger();
  let bodies = 0;
  let failedWrites = 0;
  const record = recording({ ledger: { commit: (action) => {
    if (action.kind === "message" && PlainObjectSchema.parse(action.effect.value).phase === "result") {
      failedWrites += 1;
      return Effect.fail(new AgentFailure({ operation: "canonical_assistant_write", cause: "injected_failure" }));
    }
    return ledger.ledger.commit(action);
  } } });
  const result = yield* Effect.result(createTestAgent({
    events: { publish: () => undefined }, model: { provider: "test", id: "test" },
    executor: record.executor, execution: record.executor,
    toolWave: () => Effect.sync(() => { bodies += 1; return []; }),
    llm: {
      resolveModel: () => Effect.succeed({ providerID: "test", id: "test", name: "test" }),
      run: (_input, sink) => Effect.sync(() => { sink.onMessage(pendingAssistant(["A"])); return { type: "stop" as const }; }),
    },
  }).run(runInput([{ role: "user", content: "call tools" }])));
  expect(result).toMatchObject({ _tag: "Failure" });
  expect(failedWrites).toBe(1);
  expect(bodies).toBe(0);
  expect(toolResults(ledger.committed)).toEqual([]);
})));

it("settles a defective fallback slot without interrupting its sibling or losing model evidence", () => isolated(Effect.gen(function* () {
  const siblingEntered = yield* Deferred.make<void>();
  const failed = yield* Deferred.make<void>();
  const published: string[] = [];
  const config: ObservedChatAgentConfig = {
    events: { publish: () => undefined }, model: { provider: "test", id: "test" },
    stopEvidence: fixtureStopEvidence, budget: TEST_BUDGET,
    toolExecutor: (call) => call.id === "A"
      ? Deferred.await(siblingEntered).pipe(Effect.andThen(Effect.die(new Error("slot_defect"))), Effect.ensuring(Deferred.succeed(failed, undefined)))
      : Deferred.succeed(siblingEntered, undefined).pipe(Effect.andThen(Deferred.await(failed)), Effect.as({ id: call.id, toolCallId: call.id, output: "survived" })),
  };
  const { state, turn } = fallbackTurn(config, (result) => { published.push(result.toolCallId); });
  expect(yield* settleModelTools(turn, config, state).pipe(Effect.timeout("5 seconds"))).toBe(2);
  expect(published).toEqual(["A", "B"]);
  expect(turn.turnAssistant.message?.parts).toMatchObject([
    { callID: "A", state: { status: "error" } },
    { callID: "B", state: { status: "completed", output: "survived" } },
  ]);
})));

it("propagates a fallback body's interruption instead of settling the slot as an error", () => isolated(Effect.gen(function* () {
  const config: ObservedChatAgentConfig = {
    events: { publish: () => undefined }, model: { provider: "test", id: "test" },
    stopEvidence: fixtureStopEvidence, budget: TEST_BUDGET,
    toolExecutor: (call) => call.id === "A"
      ? Effect.interrupt
      : Effect.succeed({ id: call.id, toolCallId: call.id, output: "settled" }),
  };
  const { state, turn } = fallbackTurn(config);
  const exit = yield* Effect.exit(settleModelTools(turn, config, state).pipe(Effect.timeout("5 seconds")));
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  expect(turn.turnAssistant.message?.parts).toMatchObject([
    { callID: "A", state: { status: "pending" } },
    { callID: "B", state: { status: "pending" } },
  ]);
})));

it("does not enter a body when cancellation predates the wave", () => isolated(Effect.gen(function* () {
  const controller = new AbortController();
  controller.abort();
  let entered = 0;
  const results = yield* recording().executor.runBatch([{
    request,
    body: () => Effect.sync(() => { entered += 1; return null; }),
  }], { signal: controller.signal });
  expect(results).toEqual([{ terminal: "interrupted", reason: "fiber_interrupted" }]);
  expect(entered).toBe(0);
})));

it("keeps a sequential barrier after preceding rejection and runs later work", () => isolated(Effect.gen(function* () {
  const entered: string[] = [];
  const failure = new AgentFailure({ operation: "parallel", cause: "parallel failed" });
  const results = yield* recording().executor.runBatch([
    { request, body: () => Effect.sync(() => { entered.push("parallel"); }).pipe(Effect.andThen(Effect.fail(failure))) },
    { request, sequential: true, body: () => Effect.sync(() => { entered.push("barrier"); return null; }) },
    { request, body: () => Effect.sync(() => { entered.push("following"); return null; }) },
  ], { signal: new AbortController().signal });
  expect(results).toEqual([
    { terminal: "executed", value: null, failure },
    { terminal: "executed", value: null },
    { terminal: "executed", value: null },
  ]);
  expect(entered).toEqual(["parallel", "barrier", "following"]);
})));

it("joins preceding work and blocks following work at a sequential barrier", () => isolated(Effect.scoped(Effect.gen(function* () {
  const first = Promise.withResolvers<null>();
  const barrier = Promise.withResolvers<null>();
  const firstEntered = Promise.withResolvers<void>();
  const barrierEntered = Promise.withResolvers<void>();
  const entered: string[] = [];
  const wave = yield* Effect.forkScoped(recording().executor.runBatch([
    { request, body: () => Effect.promise(() => { entered.push("A"); firstEntered.resolve(); return first.promise; }) },
    { request, sequential: true, body: () => Effect.promise(() => { entered.push("D"); barrierEntered.resolve(); return barrier.promise; }) },
    { request, body: () => Effect.sync(() => { entered.push("E"); return null; }) },
  ], { signal: new AbortController().signal }));
  try {
    yield* Effect.promise(() => bounded(firstEntered.promise));
    expect(entered).toEqual(["A"]);
    first.resolve(null);
    yield* Effect.promise(() => bounded(barrierEntered.promise));
    expect(entered).toEqual(["A", "D"]);
    barrier.resolve(null);
    yield* Fiber.join(wave);
    expect(entered).toEqual(["A", "D", "E"]);
  } finally {
    first.resolve(null);
    barrier.resolve(null);
    yield* Fiber.await(wave);
  }
}))));
