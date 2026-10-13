import { testExecutor } from "./executor";
import { type ChatFixture as ChatAgentConfig, chatServices, fixtureCompactionSeam, fixtureStopEvidence } from "./chat-services";
import { compilePolicySnapshot, KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS } from "../../src/core/gate/compile";
import { Effect } from "effect";
import type { LlmSink as Sink } from "../../src/core/llm";
import type { ChatAgentInput } from "../../src/core/types";
import type { ExecutorOptions } from "../../src/core/gate/decide";
import { runAgent } from "../../src/core/turn";
import { recordingLedger } from "./recording-ledger";
import { TEST_BUDGET } from "../helpers/approval-policy";

/** Seeded-policy chat agent over the production executor; the retry alarm is the only fixture choice. */
export function seededTestAgent(retryAlarm: NonNullable<ExecutorOptions["retryAlarm"]>) {
  return (config: ChatAgentConfig) => ({
    run(input: ChatAgentInput, sink?: Sink) {
      const record = recordingLedger();
      const executor = testExecutor({
        policy: compilePolicySnapshot({
          registry: KERNEL_POLICY_REGISTRY,
          generation: 1,
          rows: SEEDED_POLICY_ROWS.map((row: (typeof SEEDED_POLICY_ROWS)[number]) => ({
            ...row,
            generation: 1,
          })),
        }),
        ledger: record.ledger,
        observations: config.events,
        signal: config.signal,
        clock: () => Date.now(),
        entropy: record.entropy,
        random: () => 0,
        retryAlarm,
        identity: {
          sessionId: input.traceContext?.sessionId ?? "session",
          role: "resident",
          parentActionId: null,
        },
      });
      return Effect.gen(function* () {
        const fixture = { executor, execution: executor, compactionSeam: fixtureCompactionSeam, defaultBudget: TEST_BUDGET, ...config, stopEvidence: config.stopEvidence ?? fixtureStopEvidence };
        const { events: _events, llm: _llm, ...acquiredConfig } = fixture;
        return yield* runAgent(input, acquiredConfig, sink).pipe(
          Effect.provide(chatServices(fixture)),
        );
      });
    },
  });
}
