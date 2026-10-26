import { policySnapshot } from "../test/helpers/compiled-policy";
import { KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS } from "../src/core/gate/compile";
import { runAgentSync } from "../test/helpers/executor";
import { chatServices, fixtureStopEvidence } from "../test/helpers/chat-services";
import { allowConfigure, kernelRuntime, type SessionFixture, withSessionServices } from "../test/helpers/session-services";
import { catalogLayer, executorLayer } from "../test/helpers/service-layers";
import { Context, Effect, Exit, Layer, Scope } from "effect";

import { openCatalogStore } from "../src/core/store/catalog";
import { openSessionStore } from "../src/core/store/session-file";
import * as SessionHandleStore from "../src/core/store/fence";
import { accumulateUsage, Llm } from "../src/core/ports/llm";
import type { Token } from "@oni/protocol";
import { Entropy, ObservationSink } from "../src/core/ports/ports";
import { allowAllPolicy } from "../test/helpers/compiled-policy";
import type { Bench } from "tinybench";
import { closeSessions, type SessionRunnerResult } from "../src/core/session/run";
import { session } from "../src/testing/registry";
import { createSessionChatRunner } from "../src/core/session/run";
import { createDispatcher, createTurnDispatcher } from "../src/plugins/tool";
import { nullRetryAlarm, recordingLedger } from "../test/helpers/effect-g2";
import { createExecutor } from "../src/core/loop/executor";
import { runAgent } from "../src/core/loop/turn";
import { assistantWithParts } from "../test/helpers/messages";
import { completeModel, mockLlm, mockProviderModel } from "../test/helpers/mock-llm";
import { valueTool } from "../test/helpers/query-tool";
import { runInput } from "../test/helpers/run-input";
import { seedPolicy } from "../test/helpers/seed-policy";
import { TEST_APPROVAL_POLICY, TEST_BUDGET } from "../test/helpers/approval-policy";

// Keep the reference benchmark's no-op observation port; fixture helpers otherwise
// add a bus and event stamping to every dispatch, changing what this metric measures.
const events: Context.Service.Shape<typeof ObservationSink> = {
  publish: () => undefined,
  subscribe: () => () => undefined,
  scope: () => events,
};
const model = { provider: "anthropic", id: mockProviderModel.id };
const chatLayer = chatServices({ events, model, llm: mockLlm(completeModel) });
// Production pins policy and acquires service Layers for a generation, not a model call.
const policy = policySnapshot({
  registry: KERNEL_POLICY_REGISTRY,
  generation: 1,
  rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
});
// These Layers contain only pure values, so their contexts outlive acquisition.
const firstDeltaServices = runAgentSync(
  Effect.scoped(
    Layer.build(
      Layer.merge(
        chatLayer,
        executorLayer({
          policy,
          observations: events,
          clock: Date.now,
          entropy: () => crypto.randomUUID(),
        }),
      ),
    ),
  ),
);
const dispatchServices = runAgentSync(
  Effect.scoped(
    Layer.build(
      Layer.merge(
        executorLayer({
          policy: allowAllPolicy,
          observations: events,
          clock: () => 1,
          entropy: () => crypto.randomUUID(),
        }),
        catalogLayer([valueTool({ name: "echo", execute: async (value) => value })]),
      ),
    ),
  ),
).pipe(Context.add(ObservationSink, events));

export function runBenchEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

export async function firstDelta(now: () => number) {
  const first = Promise.withResolvers<number>();
  const record = recordingLedger();
  const services = firstDeltaServices.pipe(Context.add(Entropy, { id: record.entropy, random: () => 0 }));
  const input = runInput([{ role: "user", content: [{ kind: "text", text: "hello" }] }]);
  const sink = {
    onMessage: () => first.resolve(now() - start),
    onToolCall: () => undefined,
    onToolResult: () => undefined,
  };
  const start = now();
  // Keep per-turn acquisition and record-before-act inside the measured interval.
  // Drain persistence before another sample starts, but time only the first snapshot.
  await runBenchEffect(
    Effect.gen(function* () {
      const executor = yield* createExecutor({ approvalPolicy: TEST_APPROVAL_POLICY,
        ledger: record.ledger,
        retryAlarm: nullRetryAlarm,
        identity: {
          sessionId: input.traceContext.sessionId,
          role: "resident",
          parentActionId: null,
        },
      });
      return yield* runAgent(input, { model, executor, execution: executor, stopEvidence: fixtureStopEvidence, defaultBudget: TEST_BUDGET }, sink);
    }).pipe(Effect.provide(services)),
  );
  return { overriddenDuration: await first.promise };
}

export function toolDispatch() {
  const record = recordingLedger();
  const dispatcher = runAgentSync(
    Effect.gen(function* () {
      const executor = yield* createExecutor({ approvalPolicy: TEST_APPROVAL_POLICY,
        ledger: record.ledger,
        retryAlarm: nullRetryAlarm,
        identity: { sessionId: "session-1", role: "resident", parentActionId: null },
      });
      return yield* createDispatcher({ executor });
    }).pipe(Effect.provide(dispatchServices.pipe(Context.add(Entropy, { id: record.entropy, random: () => 0 })))),
  );
  return {
    committed: record.committed,
    run: () =>
      runBenchEffect(
        dispatcher.execute(
          { id: "call-1", tool: "echo", input: { value: "hello" } },
          { sessionId: "session-1", turnId: "turn-1" },
        ),
      ),
  };
}

export async function roundTrip(): Promise<{
  handle: Effect.Success<ReturnType<typeof session>>;
  kernel: SessionHandleStore.SessionKernel;
  run: () => Promise<SessionRunnerResult | undefined>;
  close: () => Promise<void>;
}> {
  // Handle-scoped kernel over fresh in-memory stores (W5.2): the benchmark owns
  // its stores' lifetime and keeps the no-op observation port as the commit sink.
  let tick = 0;
  const storeOptions = { now: () => (tick += 1), observationSink: events };
  const sessionStore = openSessionStore(":memory:", storeOptions);
  const catalog = openCatalogStore(":memory:", storeOptions);
  const kernel: SessionHandleStore.SessionKernel =
    SessionHandleStore.createSessionKernel(sessionStore, catalog);
  seedPolicy([], catalog.policies);
  const runtime: SessionFixture = {
    observations: events,
    authorizeConfigure: allowConfigure,
    ...kernelRuntime(() => kernel),
  };
  const scope = await runBenchEffect(Scope.make());
  const services = Context.pick(Llm)(await runBenchEffect(Layer.buildWithScope(chatLayer, scope)));
  const runner = createSessionChatRunner({
    prepare: (input) =>
      Effect.gen(function* () {
        // Like the resident, acquire a fresh dispatcher from the captured generation
        // on every turn; do not rebuild or override the generation's service Layers.
        const dispatcher = yield* createTurnDispatcher(input, runtime);
        return {
          config: { model, executor: dispatcher.executor, defaultBudget: TEST_BUDGET },
          traceContext: {
            traceId: "trace-agent-bench",
            sessionId: input.sessionId,
            runId: input.turnId,
          },
        };
      }),
  });
  const close = () =>
    runBenchEffect(
      closeSessions(runtime).pipe(
        Effect.ensuring(Scope.close(scope, Exit.void)),
        Effect.ensuring(
          Effect.sync(() => {
            sessionStore.close();
            catalog.close();
          }),
        ),
      ),
    );
  try {
    const handle = await runBenchEffect(
      withSessionServices(
        session(
          {
            id: "bench-turn",
            role: "resident",
            runner: (input) => runner(input).pipe(Effect.provide(services)),
          },
          runtime,
        ),
        runtime,
      ).pipe(Scope.provide(scope)),
    );
    return { handle, kernel, run: () => runBenchEffect(handle.prompt("hello")), close };
  } catch (error) {
    await close();
    throw error;
  }
}

const message = assistantWithParts("usage", "bench-turn", [], 512, 128);
const usage: Token.ProviderUsage = {
  inputTokens: message.info.tokens.input,
  outputTokens: message.info.tokens.output,
  reasoningTokens: 32,
  cacheReadTokens: 64,
  cacheWriteTokens: 16,
};

export function tokenAccounting(): Token.AgentUsage {
  const total: Token.AgentUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  accumulateUsage(total, usage);
  return total;
}

export function addTurnBenchmarks(bench: Bench): void {
  bench.add("turn/first-delta", () => firstDelta(bench.now), { async: true });

  let dispatch: ReturnType<typeof toolDispatch>;
  bench.add("turn/tool-dispatch", () => dispatch.run(), {
    async: true,
    beforeEach: () => {
      dispatch = toolDispatch();
    },
  });

  let turn: Awaited<ReturnType<typeof roundTrip>>;
  bench.add("turn/round-trip", () => turn.run(), {
    async: true,
    beforeEach: async () => {
      turn = await roundTrip();
    },
    afterEach: () => turn.close(),
  });

  bench.add("turn/token-accounting", tokenAccounting, { async: false });
}
