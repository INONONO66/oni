import { messageSource } from "../../helpers/message-source";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { isolated } from "../../helpers/isolated";
import { describe, expect, it } from "bun:test";
import { Operational, type Tool } from "@openomni/protocol";
import { runTestAgent, runUserMessage, failure, foreign } from "../../helpers/effect-g2";
import { createAssistantMessage } from "../../../src/core/journal/message-factory";
import { Bus } from "../../helpers/bus";
import { collector } from "../../helpers/observation-collector";
import { mockLlm, createStopOutcome, countingStopLlm } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";
import { expectUncalledBudget } from "../../helpers/execution-assertions";

describe("run budget terminal facts", () => {
  it("charges successful and failed tools across turns before the next admission", () =>
    isolated(
      Effect.gen(function* () {
        const events = collector();
        let modelCalls = 0;
        let executions = 0;
        const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
        const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
        const toolExecutor = (call: Tool.Call) =>
          Effect.gen(function* () {
            executions += 1;
            const slot = executions - 1;
            entered[slot]?.resolve();
            // Hold the tool open until the control fiber has moved the
            // injected clock; the billed runtime is exactly that movement.
            yield* Effect.promise(() => gates[slot]?.promise ?? Promise.resolve());
            if (executions === 2) return yield* foreign("tool", "tool failed");
            return {
              id: `result-${call.id}`,
              toolCallId: call.id,
              toolName: call.tool,
              output: "ok",
            };
          });
        const control = Effect.gen(function* () {
          yield* Effect.promise(() => entered[0].promise);
          yield* TestClock.adjust(4);
          gates[0].resolve();
          yield* Effect.promise(() => entered[1].promise);
          yield* TestClock.adjust(6);
          gates[1].resolve();
        });
        const agent = failure(
          runTestAgent(runInput([{ role: "user", content: "hi" }]), {
            events,
            model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
            budget: {
              maxTurns: -1,
              maxToolCalls: -1,
              maxWallTimeMs: -1,
              maxToolRuntimeMs: 10,
            },
            steeringPending: () => modelCalls < 3,
            tools: [
              {
                name: "lookup",
                description: "Lookup",
                inputSchema: { type: "object" },
                safe: true,
              },
            ],
            toolExecutor,
            llm: mockLlm(
              async (
                input: import("../../../src/core/ports/llm").RunInput,
                sink: import("../../../src/core/ports/llm").LlmSink,
              ) => {
                modelCalls += 1;
                input.shouldYield?.();
                const call = { id: `call-${modelCalls}`, tool: "lookup", input: {} };
                const message = createAssistantMessage("", "", "session", messageSource);
                sink.onMessage({
                  ...message,
                  parts: [
                    ...message.parts,
                    {
                      id: `tool-${modelCalls}`,
                      sessionID: "session",
                      messageID: message.info.id,
                      type: "tool",
                      callID: call.id,
                      tool: call.tool,
                      state: { status: "pending", input: call.input },
                    },
                    {
                      id: `step-${modelCalls}`,
                      sessionID: "session",
                      messageID: message.info.id,
                      type: "step-finish",
                      reason: "tool-calls",
                      tokens: {
                        input: 0,
                        output: 0,
                        reasoning: 0,
                        cache: { read: 0, write: 0 },
                      },
                    },
                  ],
                });
                return createStopOutcome();
              },
            ),
          }),
        );
        const [result] = yield* Effect.all([agent, control], { concurrency: "unbounded" });

        expect(result).toMatchObject({ code: "agent_stop", reason: "budget" });
        expect(modelCalls).toBe(2);
        expect(executions).toBe(2);
        expect(events.named(Operational.Events.Warn.name)).toContainEqual(
          expect.objectContaining({
            msg: "budget exceeded: tool wall time",
            context: expect.objectContaining({ toolCalls: 2, toolRuntimeMs: 10 }),
          }),
        );
      }).pipe(Effect.provide(TestClock.layer())),
    ));

  it("reports wall-time exhaustion through only the injected sink", async () => {
    const events = collector();
    const busEvents: string[] = [];
    const unsubscribe = Bus.observe((observation) => {
      busEvents.push(observation.name);
    });
    const provider = countingStopLlm();
    try {
      const result = await isolated(
        failure(
          runUserMessage(
            {
              events,
              model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
              budget: { maxWallTimeMs: 0 },
              llm: provider.llm,
            },
            "hi",
          ),
        ),
      );

      if (!(result instanceof Error)) throw new Error("expected budget failure");
      expectUncalledBudget(result, provider.calls);
      expect(events.named(Operational.Events.Warn.name)).toHaveLength(1);
      expect(events.named(Operational.Events.Warn.name)[0]).toMatchObject({
        msg: "budget exceeded: wall time",
        context: { type: "exceeded" },
      });
      expect(busEvents).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("correlates the exceeded-budget record to the run identity", async () => {
    const input = runInput([{ role: "user", content: "hi" }]);
    const warning = Promise.withResolvers<{ traceId: string; sessionId?: string; msg: string }>();
    const unsubscribe = Bus.subscribe(Operational.Events.Warn, warning.resolve);
    try {
      await isolated(
        failure(
          runTestAgent(input, {
            events: Bus,
            model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
            budget: { maxTurns: 0 },
            llm: mockLlm(async () => createStopOutcome()),
          }),
        ),
      );
      expect(await warning.promise).toMatchObject({
        traceId: input.traceContext.traceId,
        sessionId: input.traceContext.sessionId,
        msg: "budget exceeded: turns",
      });
    } finally {
      unsubscribe();
    }
  });
});
