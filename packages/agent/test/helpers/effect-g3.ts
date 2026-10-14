import { type ChatFixture as ChatAgentConfig, chatServices, fixtureCompactionSeam, fixtureStopEvidence } from "./chat-services";
import { KERNEL_POLICY_REGISTRY } from "../../src/core/gate/compile";
import { Effect, Cause, Exit } from "effect";

import { runAgent } from "../../src/core/loop/turn";
import type { ChatAgentInput } from "../../src/core/ports/types";
import type { LlmSink as Sink } from "../../src/core/ports/llm";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "../../src/core/gate/compile";
import type { PolicyRow } from "@openomni/protocol";
import { recordingExecutor } from "./effect-g3-recording";
import { TEST_BUDGET } from "../helpers/approval-policy";
export { recordingExecutor, recordingLedger } from "./effect-g3-recording";

export function createTestAgent(config: ChatAgentConfig) {
  return { run: (input: ChatAgentInput, sink?: Sink) => {
    const { executor } = recordingExecutor({
      policy: compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY, generation: 1, rows: SEEDED_POLICY_ROWS.map((row: Omit<PolicyRow.Row, "generation">) => ({ ...row, generation: 1 })) }),
    });
    return Effect.gen(function* () { const fixture = { executor, execution: executor, compactionSeam: fixtureCompactionSeam, defaultBudget: TEST_BUDGET, ...config, stopEvidence: config.stopEvidence ?? fixtureStopEvidence }; const { events: _events, llm: _llm, ...acquiredConfig } = fixture; return yield* runAgent(input, acquiredConfig, sink).pipe(Effect.provide(chatServices(fixture))); });
  } };
}
export function runTestAgent(input: ChatAgentInput, config: ChatAgentConfig, sink?: Sink) {
  return createTestAgent(config).run(input, sink);
}
export function failure<A, E, R>(program: Effect.Effect<A, E, R> | Promise<A>) {
  if (program instanceof Promise) return Effect.exit(Effect.promise(() => program)).pipe(Effect.map((exit) => {
    if (Exit.isSuccess(exit)) throw new Error("expected a failed Promise");
    return Cause.squash(exit.cause);
  }));
  return program.pipe(Effect.exit, Effect.map((exit: Exit.Exit<A, E>) => {
    if (Exit.isSuccess(exit)) throw new Error("expected failed Effect");
    return Cause.squash(exit.cause);
  }));
}
