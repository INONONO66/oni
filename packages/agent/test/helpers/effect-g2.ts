import type { PolicyBinding } from "../../src/core/gate/types";
import { answerThenCompaction } from "./durable-compaction";
import { runChatAttempts } from "./chat-attempts";
import { seededTestAgent } from "./seeded-test-agent";
import { recordingLedger } from "./recording-ledger";
import { commitReceivedMessage } from "./ingress";
import { isolatedLedger } from "./isolated";
import { testExecutor } from "./executor";
import { catalogLayer, dispatcherToolPorts } from "./service-layers";
import { type ChatFixture as ChatAgentConfig, fixtureConfigHead, fixtureTraceContext, prepareChatFixture, } from "./chat-services";
import type { SessionFixture as SessionRuntime } from "./session-services";
import { createSessionChatRunner } from "../../src/core/session/run";
import { createTurnDispatcher } from "../../src/plugins/tool";
import type { AnyToolDefinition } from "@oni/protocol";
import type { RunInput, RunResult } from "../../src/core/ports/llm";
import type {} from "../../src/core/session/run";
import type { SessionRunnerInput, SessionRunnerResult } from "../../src/core/session/run";
import { Cause, Effect, Exit, Fiber } from "effect";
import type { LedgerAction, SessionTransition } from "@oni/protocol";

import type { ChatAgentInput } from "../../src/core/ports/types";
import type { LlmSink as Sink } from "../../src/core/ports/llm";
import type { ExecutorOptions, DurableExecutor } from "../../src/core/loop/executor";
import type { SessionHandle } from "../../src/core/session/run";
import { AgentFailure, CommitFailed } from "../../src/core/ports/failure";
import { allowAllPolicy } from "./compiled-policy";
import { runInput } from "./run-input";

export const nullRetryAlarm: NonNullable<ExecutorOptions["retryAlarm"]> = {
  arm: () => Effect.void,
  wait: () => Effect.void,
  settle: () => Effect.void,
};

export { recordingLedger };

export function recordingExecutor(
  options: { readonly onCommit?: (action: LedgerAction.Append) => void | Promise<void> } = {},
) {
  const record = recordingLedger();
  const executor = testExecutor({
    policy: allowAllPolicy,
    retryAlarm: nullRetryAlarm,
    ledger: {
      commit: (action: LedgerAction.Append) =>
        record.ledger.commit(action).pipe(
          Effect.tap(() =>
            options.onCommit === undefined
              ? Effect.void
              : Effect.promise(async () => {
                  await options.onCommit?.(action);
                }),
          ),
        ),
    },
    observations: { publish: () => undefined },
    identity: { sessionId: "session-1", role: "resident", parentActionId: null },
    clock: () => 1,
    entropy: record.entropy,
    random: () => 0,
  });
  return { committed: record.committed, executor };
}

export function turnExecutor(policy: PolicyBinding) {
  const record = recordingLedger();
  return {
    ...record,
    executor: testExecutor({
      policy,
      ledger: record.ledger,
      observations: { publish: () => undefined },
      identity: { sessionId: "session-1", role: "resident", parentActionId: "turn-1" },
      clock: () => 1,
      entropy: record.entropy,
      random: () => 0,
      retryAlarm: nullRetryAlarm,
    }),
  };
}

export const createTestAgent = seededTestAgent(nullRetryAlarm);
export function runTestAgent(input: ChatAgentInput, config: ChatAgentConfig, sink?: Sink) {
  return createTestAgent(config).run(input, sink);
}
export function runUserMessage(config: ChatAgentConfig, content: string) {
  return runTestAgent(runInput([{ role: "user", content }]), config);
}
export function runTestOperation(
  executor: DurableExecutor,
  kind: LedgerAction.Kind,
  body: () => Effect.Effect<{ ok: boolean }>,
) {
  return executor.run(
    { kind, op: "test", intent: { requested: true }, effect: { completed: true } },
    body,
  );
}
export function receiveOutbound(message: SessionTransition.OutboundMessage, createdAt: number) {
  return Effect.suspend(() =>
    commitReceivedMessage(isolatedLedger().kernel, {
      id: message.messageId,
      sessionId: message.destinationSessionId,
      kind: "prompt",
      content: message.content,
      origin: { encodingVersion: 1, value: message },
      createdAt,
      parentActionId: null,
    }),
  ).pipe(
    Effect.mapError((error: import("../../src/core/store/errors").LedgerError) => new CommitFailed({ error })),
  );
}
export function suspendedRequest(handle: SessionHandle, suspended: Promise<void>) {
  return Effect.gen(function* () {
    const running = yield* Effect.forkScoped(handle.prompt("perform original call"));
    yield* Effect.promise(() => suspended).pipe(Effect.timeout("5 seconds"));
    const kernel = isolatedLedger().kernel;
    const request = kernel.requestRows(handle.id)[0];
    if (request === undefined) throw new Error("missing request");
    return {
      running,
      settled: Fiber.await(running),
      request,
      fence: kernel.row(handle.id).fence,
    };
  });
}
export { runChatAttempts };
export function answerThenCompact(executor: DurableExecutor, input: SessionRunnerInput) {
  return answerThenCompaction(executor, input.kernel, input.sessionId, "answer").pipe(
    Effect.map(() => ({ kind: "result", text: "answer", finishReason: "stop" }) satisfies SessionRunnerResult),
  );
}

export function dispatchingRunner(
  definitions: readonly AnyToolDefinition[],
  runtime: () => SessionRuntime,
  model: (request: RunInput, sink: Sink, input: SessionRunnerInput) => Promise<RunResult>,
) {
  return createSessionChatRunner({
    prepare: (input: SessionRunnerInput) =>
      Effect.gen(function* () {
        const dispatcher = yield* createTurnDispatcher(input, runtime()).pipe(
          Effect.provide(catalogLayer(definitions)),
        );
        return prepareChatFixture({
          traceContext: fixtureTraceContext(input),
          config: {
            ...fixtureConfigHead(dispatcher.executor),
            ...dispatcherToolPorts(dispatcher, input),
            llm: {
              resolveModel: () => Effect.succeed({ providerID: "test", id: "test", name: "test" }),
              run: (request: RunInput, sink: Sink) =>
                Effect.promise(() => model(request, sink, input)),
            },
          },
        });
      }),
  });
}

export function foreign(operation: string, cause: string | Error) {
  return new AgentFailure({ operation, cause: String(cause) });
}

/** Inspect typed failures and defects without Promise rejection wrappers. */
export function failure<A, E, R>(program: Effect.Effect<A, E, R>) {
  return program.pipe(
    Effect.exit,
    Effect.map((exit: Exit.Exit<A, E>) => {
      if (Exit.isSuccess(exit)) throw new Error("expected a failed Effect");
      // The squashed value is whatever the program failed or died with; the
      // caller's assertion narrows it.
      return Cause.squash(exit.cause);
    }),
  );
}
