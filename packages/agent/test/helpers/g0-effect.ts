import { testExecutor } from "./executor";
import type { ChatFixture as ChatAgentConfig } from "./chat-services";
import { Effect } from "effect";
import type { LlmSink as Sink } from "../../src/core/ports/llm";
import type { ChatAgentInput } from "../../src/core/ports/types";
import { compiledPolicy } from "./compiled-policy";
import { recordingLedger } from "./recording-ledger";
import { seededTestAgent } from "./seeded-test-agent";

/** Effect-native recording port; the production executor still owns all policy and execution. */
export { recordingLedger };

const immediateRetryAlarm = {
  arm: () => Effect.void,
  wait: () => Effect.void,
  settle: () => Effect.void,
};

export function recordingExecutor() {
  const record = recordingLedger();
  return {
    ...record,
    executor: testExecutor({
      policy: compiledPolicy(),
      ledger: record.ledger,
      retryAlarm: immediateRetryAlarm,
      observations: { publish: () => undefined },
      identity: { sessionId: "session-1", role: "resident", parentActionId: null },
      clock: () => 1,
      entropy: record.entropy,
      random: () => 0,
    }),
  };
}

export const createTestAgent = seededTestAgent(immediateRetryAlarm);

export function runTestAgent(input: ChatAgentInput, config: ChatAgentConfig, sink?: Sink) {
  return createTestAgent(config).run(input, sink);
}
