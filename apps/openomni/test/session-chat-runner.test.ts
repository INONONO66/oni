import { attemptIntentIds, isAttemptRow, isLogicalLlm } from "../../../packages/agent/test/helpers/llm-rows";
import { runAgentSync } from "../../../packages/agent/test/helpers/executor";
import { sessionTree } from "../../../packages/agent/test/helpers/session-tree";
import { pinnedModelSelection, restoreModelSelection } from "../src/composition/model-selection";
import { testTurnDispatcher } from "../../../packages/agent/test/helpers/service-layers";
import { fixtureStopEvidence, prepareChatFixture } from "../../../packages/agent/test/helpers/chat-services";
import { allowConfigure, isolatedRuntime, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices, } from "../../../packages/agent/test/helpers/session-services";
import { KERNEL_POLICY_REGISTRY } from "../../../packages/agent/src/core/gate/compile";
import { Cause, Effect, Exit } from "effect";
import type { LlmSink, RunInput } from "../../../packages/agent/src/core/llm";
import { isolated, isolatedLedger } from "../../../packages/agent/test/helpers/isolated";
import { providerFailure } from "../../../packages/agent/test/helpers/mock-llm";
import { seedPolicy } from "../../../packages/agent/test/helpers/seed-policy";
import { describe, expect, it } from "bun:test";

import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "../../../packages/agent/src/core/gate/compile";
import { SessionTurn, type LedgerAction, type Model } from "@openomni/protocol";
import { closeSessions, createSessionChatRunner } from "../../../packages/agent/src/core/run";
import type { Executor } from "../../../packages/agent/src/core/gate/decide";
import { Bus } from "../../../packages/agent/test/helpers/bus";
import type { SessionHandle, SessionRunnerInput } from "../../../packages/agent/src/core/run";
import { session } from "../../../packages/agent/src/testing/registry";
import { turnExecutor, nullRetryAlarm, foreign } from "../../../packages/agent/test/helpers/effect-g2";
import { recordingChatRunner } from "../../../packages/agent/test/helpers/session-chat";
import { completeModel, createStopOutcome, mockLlm, type MockLlmFn, mockProviderModel } from "../../../packages/agent/test/helpers/mock-llm";

const policy = compilePolicySnapshot({
  registry: KERNEL_POLICY_REGISTRY,
  generation: 0,
  rows: SEEDED_POLICY_ROWS.map(
    (row: Omit<import("@openomni/protocol").PolicyRow.Row, "generation">) => ({
      ...row,
      generation: 0,
    }),
  ),
});

function input(
  boundary: SessionRunnerInput["boundary"],
  messages: SessionRunnerInput["messages"] = [{ role: "user", text: "initial" }],
): SessionRunnerInput {
  const kernel = isolatedLedger().kernel;
  const seeded = runAgentSync(
    kernel.materialize({
      id: "session-1",
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "system", blocks: [] },
      policyGeneration: 0,
      actionId: "fixture-configure",
      at: 1,
    }),
  );
  if (seeded.created) {
    const actions = isolatedLedger().session.actions;
    for (const [index, message] of messages.entries())
      actions.append(
        {
          id: `fixture-delivery-${index}`,
          sessionId: "session-1",
          parentId: null,
          kind: "prompt",
          intent: { encodingVersion: 1, value: {} },
          effect: {
            encodingVersion: 1,
            value: {
              phase: "delivery",
              turnId: "turn-1",
              deliveryId: message.id ?? `fixture-message-${index}`,
              kind: "prompt",
              content: message.text,
              origin: { encodingVersion: 1, value: {} },
              boundary: "before_llm",
            },
          },
          ts: 1,
          irreversible: true,
        },
        kernel.row("session-1").revision,
      );
  }
  return {
    sessionId: "session-1",
    kernel,
    role: "resident",
    turnId: "turn-1",
    actionId: "action-1",
    stopEvidence: fixtureStopEvidence,
    ledger: {
      commit: () =>
        Effect.sync(() => {
          throw new Error("session runner fixture does not commit ledger actions");
        }),
    },
    resultId: "result-1",
    parentActionId: null,
    boundaryActionId: null,
    messages,
    tools: [],
    toolsGeneration: 1,
    toolsHash: "tools-hash",
    system: "system",
    systemHash: "system-hash",
    policyGeneration: 0,
    resumeCount: 0,
    signal: new AbortController().signal,
    boundary,
  };
}

function testExecutor(): Executor {
  return turnExecutor(policy).executor;
}

function config(run: MockLlmFn, executor: Executor = testExecutor(), fallbacks?: Model.Ref[]) {
  return {
    events: { publish: () => undefined },
    executor,
    model: { provider: "anthropic", id: mockProviderModel.id },
    ...(fallbacks === undefined ? {} : { modelFallbacks: fallbacks }),
    llm: {
      ...mockLlm(run),
      // With fallbacks, echo the selected ref so the recorded chat names the model that answered.
      ...(fallbacks === undefined ? {} : { resolveModel: echoModel }),
    },
  };
}

const echoModel = (model: Model.Ref) =>
  Effect.succeed({
    id: model.id,
    name: model.id,
    providerID: model.provider,
  });

const traceContext = { traceId: "trace-1", sessionId: "session-1", runId: "run-1" };

function actionPhase(action: LedgerAction.Node): string | undefined {
  const value = action.intent.value;
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return typeof value.phase === "string" ? value.phase : undefined;
}

function promptTurns(handle: SessionHandle, turns: number) {
  return Effect.gen(function* () {
    for (let prompt = 0; prompt < turns; prompt += 1) {
      const result = yield* handle.prompt(`run durable turn ${prompt + 1}`);
      if (result?.kind !== "result") throw new Error("durable chat did not return a result");
    }
  });
}

function runDurably(
  run: MockLlmFn,
  { prompts = 1, fallbacks }: { readonly prompts?: number; readonly fallbacks?: Model.Ref[] } = {},
) {
  return Effect.gen(function* () {
    Bus.reset();
    let nextId = 0;
    const runtime: SessionRuntime = {
      authorizeConfigure: allowConfigure,
      observations: Bus,
      clock: () => 1_000,
      entropy: () => `boundary-id-${++nextId}`,
      processId: "boundary-test",
      retryAlarm: nullRetryAlarm,
      ...isolatedRuntime(),
    };
    seedPolicy();
    const chatRunner = createSessionChatRunner({
      prepare: (input: import("../../../packages/agent/src/core/run").SessionRunnerInput) =>
        Effect.gen(function* () {
          return prepareChatFixture({
            config: {
              ...config(
                run,
                (yield* testTurnDispatcher(input, runtime)).executor,
                fallbacks,
              ),
              restoreModelSelection,
            },
            traceContext,
          });
        }),
      pinnedModel: pinnedModelSelection,
    });
    const handle = yield* Effect.gen(function* () {
      const fixture: SessionFixture = runtime;
      return yield* withSessionServices(
        session({ id: "boundary-session", role: "resident", runner: chatRunner }, fixture),
        fixture,
      );
    });

    try {
      yield* promptTurns(handle, prompts);
      // W5.2: the delivery table is gone; the turn intent's durable `deliveryIds`
      // name the consumed received-message chain actions.
      const actions = sessionTree(isolatedLedger().kernel, handle.id);
      return {
        actions,
        deliveryIds: actions
          .filter(
            (action: LedgerAction.Node) =>
              action.kind === "turn" && actionPhase(action) === "intent",
          )
          .flatMap(
            (action: LedgerAction.Node) =>
              SessionTurn.DecodeIntent.parse(action.intent.value).deliveryIds,
          ),
      };
    } finally {
      yield* closeSessions(runtime);
      Bus.reset();
    }
  });
}

describe("session chat runner", () => {
  it("returns interrupted before invoking the model", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;
          const runner = createSessionChatRunner({
            prepare: () =>
              Effect.gen(function* () {
                return prepareChatFixture({
                  config: config(async () => {
                    calls += 1;
                    return createStopOutcome();
                  }),
                  traceContext,
                });
              }),
          });

          const result = yield* runner(
            input(() => Effect.succeed({ messages: [], interrupted: true })),
          );

          expect(result).toEqual({ kind: "interrupted" });
          expect(calls).toBe(0);
        }),
      ),
    ));

  it("passes boundary messages into the model and returns its terminal result", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const boundaries: string[] = [];
          const { runner, modelInputs } = recordingChatRunner(config, traceContext);

          const result = yield* runner(
            input((boundary: import("@openomni/protocol").SessionTurn.Boundary) =>
              Effect.succeed(
                (() => {
                  boundaries.push(boundary);
                  return boundary === "before_llm"
                    ? { messages: [{ role: "user", text: "steered" }], interrupted: false }
                    : { messages: [], interrupted: false };
                })(),
              ),
            ),
          );

          expect(boundaries).toEqual(["before_llm", "after_llm", "after_tools"]);
          expect(modelInputs[0]).toContain('"role":"user"');
          expect(modelInputs[0]).toContain('"text":"initial"');
          expect(modelInputs[0]).toContain('"text":"steered"');
          expect(modelInputs[0]?.indexOf('"text":"initial"')).toBeLessThan(
            modelInputs[0]?.indexOf('"text":"steered"') ?? -1,
          );
          expect(result).toMatchObject({ kind: "result", finishReason: "stop" });
        }),
      ),
    ));

  it("starts another model turn when a post-model boundary supplies continuation", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          let afterLlm = 0;
          const { runner, modelInputs } = recordingChatRunner(config, traceContext);

          const result = yield* runner(
            input((boundary: import("@openomni/protocol").SessionTurn.Boundary) =>
              Effect.succeed(
                (() => {
                  if (boundary === "after_llm" && afterLlm++ === 0) {
                    return { messages: [{ role: "user", text: "continue" }], interrupted: false };
                  }
                  return { messages: [], interrupted: false };
                })(),
              ),
            ),
          );

          expect(modelInputs).toHaveLength(2);
          expect(modelInputs[1]).toContain('"role":"assistant"');
          expect(modelInputs[1]).toContain('"text":"continue"');
          expect(modelInputs[1]?.indexOf('"role":"assistant"')).toBeLessThan(
            modelInputs[1]?.indexOf('"text":"continue"') ?? -1,
          );
          expect(result.kind).toBe("result");
        }),
      ),
    ));

  it("returns interrupted at either post-model boundary", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          for (const interruptedAt of ["after_llm", "after_tools"] as const) {
            const runner = createSessionChatRunner({
              prepare: () =>
                Effect.sync(() =>
                  prepareChatFixture({ config: config(completeModel), traceContext }),
                ),
            });
            const result = yield* runner(
              input((boundary: import("@openomni/protocol").SessionTurn.Boundary) =>
                Effect.succeed({
                  messages: [],
                  interrupted: boundary === interruptedAt,
                }),
              ),
            );
            expect(result.kind).toBe("interrupted");
          }
        }),
      ),
    ));

  it("records real prompt and turn ownership with sibling llm pairs for normal calls", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;

          const { actions, deliveryIds } = yield* runDurably(
            async (input: RunInput, sink: LlmSink) => {
              calls += 1;
              return calls === 1 ? { type: "continue" } : completeModel(input, sink);
            },
          );

          const attemptIds = attemptIntentIds(actions);
          const llmIntents = actions.filter(
            (action: import("@openomni/protocol").LedgerAction.Node) =>
              isLogicalLlm(action, attemptIds) && actionPhase(action) === "intent",
          );
          const llmResults = actions.filter(
            (action: import("@openomni/protocol").LedgerAction.Node) =>
              isLogicalLlm(action, attemptIds) && actionPhase(action) === "result",
          );
          expect(calls).toBe(2);
          expect(llmIntents).toHaveLength(2);
          expect(llmResults).toHaveLength(2);

          const turnIntents = actions.filter(
            (action: import("@openomni/protocol").LedgerAction.Node) =>
              action.kind === "turn" && actionPhase(action) === "intent",
          );
          const turnTerminals = actions.filter(
            (action: import("@openomni/protocol").LedgerAction.Node) =>
              action.kind === "turn" && actionPhase(action) === "terminal",
          );
          expect(turnIntents).toHaveLength(1);
          expect(turnTerminals).toHaveLength(1);
          const turnIntent = turnIntents[0];
          if (turnIntent === undefined) throw new Error("missing durable turn intent");
          expect(
            llmIntents.map(
              (action: import("@openomni/protocol").LedgerAction.Node) => action.parentId,
            ),
          ).toEqual([turnIntent.id, turnIntent.id]);
          expect(
            llmResults.map(
              (action: import("@openomni/protocol").LedgerAction.Node) => action.parentId,
            ),
          ).toEqual(
            llmIntents.map((action: import("@openomni/protocol").LedgerAction.Node) => action.id),
          );

          // #1252: the delivery row shares the prompt kind; the admission row has no delivery phase.
          const prompts = actions.filter(
            (action: import("@openomni/protocol").LedgerAction.Node) =>
              action.kind === "prompt" &&
              (action.effect.value as { phase?: string } | null)?.phase !== "delivery",
          );
          expect(prompts).toHaveLength(1);
          expect(prompts[0]?.id).toBe(deliveryIds[0]);
        }),
      ),
    ));

  it("records retry attempts beneath one logical llm action", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;

          const { actions } = yield* runDurably(
            async (input: RunInput, sink: LlmSink) => {
              calls += 1;
              return calls === 1
                ? { type: "error", error: providerFailure("transient provider outage", { failureClass: { kind: "retryable", reason: "transient_error", providerReason: "server_error", afterMs: 0, directed: true, instant: false } }) }
                : completeModel(input, sink);
            },
          );

          const attemptIds = attemptIntentIds(actions);
          const llmIntents = actions.filter(
            (action: import("@openomni/protocol").LedgerAction.Node) =>
              isLogicalLlm(action, attemptIds) && actionPhase(action) === "intent",
          );
          const attempts = actions.filter(
            (action: import("@openomni/protocol").LedgerAction.Node) =>
              isAttemptRow(action, attemptIds) && actionPhase(action) === "intent",
          );
          const attemptResults = actions.filter(
            (action: import("@openomni/protocol").LedgerAction.Node) =>
              isAttemptRow(action, attemptIds) && actionPhase(action) === "result",
          );
          expect(calls).toBe(2);
          expect(llmIntents).toHaveLength(1);
          expect(attempts).toHaveLength(2);
          expect(
            attemptResults.map(
              (action: import("@openomni/protocol").LedgerAction.Node) => action.parentId,
            ),
          ).toEqual(
            attempts.map((action: import("@openomni/protocol").LedgerAction.Node) => action.id),
          );
          const llmIntent = llmIntents[0];
          if (llmIntent === undefined) throw new Error("missing logical llm intent");
          expect(
            attempts.map(
              (action: import("@openomni/protocol").LedgerAction.Node) => action.parentId,
            ),
          ).toEqual([llmIntent.id, llmIntent.id]);
        }),
      ),
    ));

  it("restores the primary model at the next turn boundary as a recorded llm action", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const fallback = { provider: "openai", id: "gpt-4o" };
          const answered: string[] = [];

          const { actions } = yield* runDurably(
            async (input: RunInput, sink: LlmSink) => {
              answered.push(input.model.id);
              return answered.length === 1
                ? { type: "error", error: providerFailure("transient provider outage", { failureClass: { kind: "retryable", reason: "transient_error", providerReason: "server_error", afterMs: 0, directed: true, instant: false } }) }
                : completeModel(input, sink);
            },
            { prompts: 2, fallbacks: [fallback] },
          );

          const llmIntents = actions
            .filter(
              (action: import("@openomni/protocol").LedgerAction.Node) =>
                isLogicalLlm(action, attemptIntentIds(actions)) && actionPhase(action) === "intent",
            )
            .map((action: import("@openomni/protocol").LedgerAction.Node) => action.intent.value);
          expect(answered).toEqual([mockProviderModel.id, fallback.id, mockProviderModel.id]);
          expect(llmIntents).toMatchObject([
            { op: "chat", value: { model: mockProviderModel.id } },
            {
              op: "restore_model_selection",
              value: { from: fallback, to: { provider: "anthropic", id: mockProviderModel.id } },
            },
            { op: "chat", value: { model: mockProviderModel.id } },
          ]);
        }),
      ),
    ));

  it("does not invoke the model when a durable chat composition loses its executor", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;
          const preparedConfig = config(async () => {
            calls += 1;
            return createStopOutcome();
          });
          Reflect.deleteProperty(preparedConfig, "executor");
          const runner = createSessionChatRunner({
            prepare: () =>
              Effect.sync(() => prepareChatFixture({ config: preparedConfig, traceContext })),
          });

          const exit = yield* Effect.exit(
            runner(input(() => Effect.succeed({ messages: [], interrupted: false }))),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(TypeError);
          expect(calls).toBe(0);
        }),
      ),
    ));

  it("turns reported failures into error results and rethrows unreported failures", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const cause = foreign("chat", "failed");
          const prepared = { config: config(completeModel), traceContext };
          const reported = createSessionChatRunner({
            prepare: () => Effect.sync(() => prepareChatFixture(prepared)),
            reportError: (error: Error) => (error === cause ? "reported" : undefined),
          });
          const unreported = createSessionChatRunner({
            prepare: () => Effect.sync(() => prepareChatFixture(prepared)),
          });
          const ready = input(() => Effect.fail(cause));

          expect(yield* reported(ready)).toEqual({
            kind: "error",
            text: "reported",
            cause,
            reported: true,
          });
          expect(yield* Effect.flip(unreported(ready))).toBe(cause);
          const defect = new Error("prepare failed");
          const defective = createSessionChatRunner({
            prepare: () =>
              Effect.sync(() => {
                throw defect;
              }),
          });
          const exit = yield* Effect.exit(defective(ready));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect);
        }),
      ),
    ));
});
