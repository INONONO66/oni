import { newTraceId } from "./bus";
import type { RunTrace } from "../../src/core/turn";
import type { ChatAgentInput } from "../../src/core/types";

/**
 * A run input carrying a real identity. The runner refuses to mint one: a run whose traceId, sessionId and
 * runId were invented on its behalf emits events that correlate to nothing, and the caller never learns it
 * forgot — so tests state the identity the way production does rather than leaning on a default.
 */
export function runInput(
  messages: ChatAgentInput["messages"],
): ChatAgentInput & { traceContext: RunTrace } {
  return {
    messages,
    traceContext: {
      traceId: newTraceId(),
      sessionId: `session-${newTraceId()}`,
      runId: `run-${newTraceId()}`,
    },
  };
}
