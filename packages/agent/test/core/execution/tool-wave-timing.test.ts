import { expect, it } from "bun:test";
import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";
import type { Tool } from "@openomni/protocol";
import { isolated } from "../../helpers/isolated";
import { readyWaveTurn } from "../../helpers/tool-wave";
import { fixtureStopEvidence } from "../../helpers/chat-services";
import { settleModelTools } from "../../../src/core/loop/tool";
import type { ObservedChatAgentConfig } from "../../../src/core/ports/types";
import { TEST_BUDGET } from "../../helpers/approval-policy";

const sessionId = "session-wave-timing";

const waveTurn = (config: ObservedChatAgentConfig) => readyWaveTurn(config, sessionId);

/**
 * Tool-wave duration is computed from the injected Effect Clock —
 * the wave's start/end stamps and the budget's union billing are exactly the
 * clock movement between tool start and tool end, never ambient Date.now.
 */
it("records the exact injected-clock duration and bills the wave union once", () =>
  isolated(
    Effect.gen(function* () {
      const waveEntered = Promise.withResolvers<void>();
      const waveGate = Promise.withResolvers<void>();
      const config: ObservedChatAgentConfig = {
        events: { publish: () => undefined },
        model: { provider: "test", id: "test" },
        stopEvidence: fixtureStopEvidence, budget: TEST_BUDGET,
        toolWave: (calls: readonly Tool.Call[]) =>
          Effect.gen(function* () {
            waveEntered.resolve();
            // Hold the wave open until the control fiber has moved the
            // injected clock; the recorded duration is exactly that movement.
            yield* Effect.promise(() => waveGate.promise);
            return calls.map((call) => ({
              id: call.id,
              toolCallId: call.id,
              toolName: call.tool,
              output: `done-${call.id}`,
            }));
          }),
      };
      const { state, turn } = waveTurn(config);
      const waveStart = yield* Clock.currentTimeMillis;
      const control = Effect.gen(function* () {
        yield* Effect.promise(() => waveEntered.promise);
        yield* TestClock.adjust(37);
        waveGate.resolve();
      });
      const [settled] = yield* Effect.all(
        [settleModelTools(turn, config, state).pipe(Effect.timeout("5 seconds")), control],
        { concurrency: "unbounded" },
      );
      expect(settled).toBe(2);

      // The union of the two concurrent slots is billed once: 37ms, not 74ms.
      expect(state.budgetState.toolRuntimeMs).toBe(37);
      expect(state.budgetState.toolCalls).toBe(2);

      // Both slots carry the exact injected-clock start/end stamps.
      expect(turn.turnAssistant.message?.parts).toMatchObject([
        {
          callID: "A",
          state: {
            status: "completed",
            output: "done-A",
            time: { start: waveStart, end: waveStart + 37 },
          },
        },
        {
          callID: "B",
          state: {
            status: "completed",
            output: "done-B",
            time: { start: waveStart, end: waveStart + 37 },
          },
        },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));
