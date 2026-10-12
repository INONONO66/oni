import { runAgentSync } from "./helpers/executor";
import { catalogLayer, executorLayer } from "./helpers/service-layers";
import { describe, expect, it } from "bun:test";
import { Effect, Fiber } from "effect";
import { isolated } from "./helpers/isolated";

import {
  createDispatcher,
  createTurnDispatcher,
  currentExecutor,
  defineTool,
  type Executor,
} from "./helpers/effect-g3-dispatcher";
import { AgentFailure } from "../src/core/failure";
import { currentInvocation, requireOpenInvocation, ExecutorContextError } from "../src/core/gate/decide";
import { GenerationOwnership, SessionLayer } from "../src/core/ports";
import { z } from "zod";
import { recordingExecutor, recordingLedger } from "./helpers/effect-g3";
import { allowAllPolicy, opPhaseOf } from "./helpers/compiled-policy";
import { TEST_APPROVAL_POLICY } from "./helpers/approval-policy";

function tool(
  name: string,
  execute: (input: object, context: { readonly signal: AbortSignal }) => Promise<string>,
  output = z.string(),
) {
  return defineTool({
    name,
    description: name,
    category: "query",
    input: z.object({}).strict(),
    output,
    visibility: { model: ["resident"], cell: ["resident"] },
    execute,
    render: (_input, value) => value,
  });
}

const passThrough = recordingExecutor().executor;

const context = { sessionId: "session-1", turnId: "turn-1" };
const call = (name: string) => ({ id: `call-${name}`, tool: name, input: {} });

describe("createTurnDispatcher", () => {
  it("exposes the captured invocation only inside its dispatched tool body", () =>
    isolated(Effect.gen(function* () {
      expect(currentInvocation).toThrow(ExecutorContextError);
      const generation = yield* GenerationOwnership;
      const { policy } = yield* SessionLayer;
      const recording = recordingLedger();
      let bodies = 0;
      const dispatcher = yield* createTurnDispatcher({
        sessionId: context.sessionId,
        role: "resident",
        actionId: context.turnId,
        ledger: recording.ledger,
      }, { approvalPolicy: TEST_APPROVAL_POLICY }).pipe(Effect.provide(catalogLayer([
        tool("invocation", async () => {
          const frame = requireOpenInvocation();
          expect(frame).toBe(currentInvocation());
          expect(frame.executor).toBe(currentExecutor());
          expect(frame.cell.executor).toBe(frame.executor);
          expect(frame.policy).toBe(policy);
          expect(frame.generation).toBe(generation);
          bodies += 1;
          return "captured";
        }),
      ])));
      expect(yield* dispatcher.execute(call("invocation"), context)).toMatchObject({ content: "captured" });
      expect(bodies).toBe(1);
      expect(currentInvocation).toThrow(ExecutorContextError);
    })),
  );

  it("composes a durable executor and commits intent before result", async () => {
    const recording = recordingLedger();
    const dispatcher = createTurnDispatcher(
      {
        sessionId: "session-1",
        role: "resident",
        actionId: "turn-1",
        ledger: recording.ledger,
      },
      { approvalPolicy: TEST_APPROVAL_POLICY },
    ).pipe(Effect.provide(catalogLayer([tool("echo", async () => "ok")])),
      Effect.provide(executorLayer({ policy: allowAllPolicy, observations: { publish: () => undefined }, clock: () => 1, entropy: recording.entropy })));

    const result = await isolated(Effect.flatMap(dispatcher, (value) => value.execute(call("echo"), context)));

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("ok");
    expect(recording.committed.filter((action) => action.kind === "tool").map(opPhaseOf)).toEqual([
      "echo:intent",
      "echo:result",
    ]);
  });
});

describe("wave settlement", () => {
  // #1344: no injection option — settlement is observable through the real
  // dispatch path. `boom` rejects at once; `ok` parks on a gate the test opens
  // only on a later macrotask, after every microtask an early-resolving wave
  // could have queued has drained. The settlement log therefore places the
  // wave after BOTH bodies only if executeWave actually waited for them.
  it("executeWave resolves only after every model wave body settles", async () => {
    const log: string[] = [];
    let settledWaveBodies = 0;
    let settledSingleBodies = 0;
    const gate = Promise.withResolvers<void>();
    const okParked = Promise.withResolvers<void>();
    const boomRejected = Promise.withResolvers<void>();
    const dispatcher = runAgentSync(createDispatcher({ executor: passThrough }).pipe(Effect.provide(catalogLayer([
      tool("ok", async () => {
        okParked.resolve();
        await gate.promise;
        settledWaveBodies += 1;
        log.push("ok settled");
        return "fine";
      }),
      tool("boom", async () => {
        settledWaveBodies += 1;
        log.push("boom settled");
        boomRejected.resolve();
        throw new Error("x");
      }),
      tool("single", async () => {
        settledSingleBodies += 1;
        return "fine";
      }),
    ]))));

    const wave = isolated(dispatcher.executeWave([call("ok"), call("boom")], context)).then((results) => {
      log.push("wave resolved");
      return results;
    });
    await Promise.all([okParked.promise, boomRejected.promise]);
    expect(log).toEqual(["boom settled"]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    gate.resolve();
    const results = await wave;

    expect(settledWaveBodies).toBe(2);
    expect(log).toEqual(["boom settled", "ok settled", "wave resolved"]);
    expect(results.map((result) => result.isError)).toEqual([undefined, true]);

    // The single-call doors settle their own body, counted apart from the wave.
    await isolated(dispatcher.execute(call("single"), context));
    expect(settledSingleBodies).toBe(1);
    await isolated(dispatcher.executeCell(call("single"), context));
    expect(settledSingleBodies).toBe(2);
    expect(settledWaveBodies).toBe(2);
  });
});

describe("currentExecutor", () => {
  it("throws outside an active execution", () => {
    expect(() => currentExecutor()).toThrow(ExecutorContextError);
  });

  it("returns the executor running the tool body", async () => {
    let seen: Executor | undefined;
    const dispatcher = runAgentSync(createDispatcher({ executor: passThrough }).pipe(Effect.provide(catalogLayer([
        tool("probe", async () => {
          seen = currentExecutor();
          return "probed";
        }),
      ]))));

    await isolated(dispatcher.execute(call("probe"), context));

    expect(seen).toBe(passThrough);
  });
});

describe("tool body outcomes", () => {
  it("settles a never-resolving body as timed_out", async () => {
    const dispatcher = runAgentSync(createDispatcher({
        executor: passThrough,
        timeoutMs: 5,
      }).pipe(Effect.provide(catalogLayer([tool("stall", () => new Promise<string>(() => undefined))]))));

    const result = await isolated(dispatcher.execute(call("stall"), context));

    expect(result).toMatchObject({ isError: true, errorKind: "execution_failed" });
  });

  it("forwards the caller's abort reason into a timed body's signal", async () => {
    const caller = new AbortController();
    const bodyEntered = Promise.withResolvers<void>();
    let sawCallerReason = false;
    const dispatcher = runAgentSync(createDispatcher({ executor: passThrough, timeoutMs: 1000 }).pipe(Effect.provide(catalogLayer([
        tool("abortable", (_input, { signal }) => {
          bodyEntered.resolve();
          return new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                expect(() => signal.throwIfAborted()).toThrow("caller aborted");
                sawCallerReason = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
        }),
      ]))));

    const result = await isolated(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(dispatcher.execute(call("abortable"), { ...context, signal: caller.signal }));
      yield* Effect.promise(() => bodyEntered.promise);
      const reason = new Error("caller aborted");
      caller.abort(reason);
      return yield* Fiber.join(fiber);
    }));
    expect(sawCallerReason).toBe(true);
    expect(result).toMatchObject({ isError: true, errorKind: "execution_failed" });
  });

  it("clears the timer when the body finishes inside the timeout", async () => {
    const dispatcher = runAgentSync(createDispatcher({
      executor: passThrough,
      timeoutMs: 1000,
    }).pipe(Effect.provide(catalogLayer([tool("fast", async () => "done")]))));

    const result = await isolated(dispatcher.execute(call("fast"), context));

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("done");
  });

  it("fails closed when the body violates the output schema", async () => {
    const dispatcher = runAgentSync(createDispatcher({ executor: passThrough }).pipe(Effect.provide(catalogLayer([
        tool(
          "bad-output",
          async () => "anything",
          z.string().refine(() => false),
        ),
      ]))));

    const result = await isolated(dispatcher.execute(call("bad-output"), context));

    expect(result).toMatchObject({ isError: true, errorKind: "invalid_output" });
  });

  // #1344 r1 M1: a body that throws a non-Error, or an Error with an empty
  // message, keeps the pre-#1344 `String(thrown)` bytes on BOTH the committed
  // result-row evidence and the model-facing error text. The structured-cause
  // path must not re-render them (`Error: 42`, `Error: ` were the regressions).
  it("renders non-Error and empty-message throws byte-identically to String(thrown)", async () => {
    const recording = recordingExecutor();
    const dispatcher = runAgentSync(createDispatcher({ executor: recording.executor }).pipe(Effect.provide(catalogLayer([
      // biome-ignore lint/style/useThrowOnlyError: a tool body is a foreign port; the non-Error throw is the case under test
      tool("throws-number", async () => { throw 42; }),
      // biome-ignore lint/style/useThrowOnlyError: same — the `[object Object]` rendering is the pinned byte
      tool("throws-object", async () => { throw { a: 1 }; }),
      // biome-ignore lint/style/useThrowOnlyError: same — `null` must render as "null"
      tool("throws-null", async () => { throw null; }),
      // biome-ignore lint/suspicious/useErrorMessage: an empty message must render as the bare name, as String(error) does
      tool("throws-empty-error", async () => { throw new Error(""); }),
    ]))));
    const expected: Record<string, string> = {
      "throws-number": "42",
      "throws-object": "[object Object]",
      "throws-null": "null",
      "throws-empty-error": "Error",
    };
    const names = Object.keys(expected);

    const results = await isolated(dispatcher.executeWave(names.map(call), context));

    expect(Object.fromEntries(results.map((result) => [result.toolName, result.content]))).toEqual(expected);
    expect(results.every((result) => result.isError === true && result.errorKind === "execution_failed")).toBe(true);
    const evidenceByTool = Object.fromEntries(recording.committed
      .filter((action) => action.kind === "tool")
      .map((action) => action.effect.value)
      .flatMap((effect) => typeof effect === "object" && effect !== null && !Array.isArray(effect) && effect.phase === "result" ? [effect.evidence] : [])
      .flatMap((evidence) => typeof evidence === "object" && evidence !== null && !Array.isArray(evidence) && Array.isArray(evidence.failures) ? evidence.failures : [])
      .flatMap((failure) => typeof failure === "object" && failure !== null && !Array.isArray(failure) && failure.tag === "ToolBodyFailed" ? [[failure.tool, failure.cause]] : []));
    expect(evidenceByTool).toEqual(expected);
  });

  it("propagates an executor failure to the caller", async () => {
    const failure = new AgentFailure({ operation: "test", cause: "ledger unavailable" });
    const failing: Executor = {
      run() {
        return Effect.fail(failure);
      },
      runBatch() {
        return Effect.fail(failure);
      },
    };
    const dispatcher = runAgentSync(createDispatcher({ executor: failing }).pipe(Effect.provide(catalogLayer([tool("echo", async () => "ok")]))));

    const result = await isolated(Effect.result(dispatcher.execute(call("echo"), context)));
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "AgentFailure", operation: "test" } });
  });
});
