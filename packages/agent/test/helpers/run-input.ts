import { newTraceId } from "./bus";
import type { RunTrace } from "../../src/core/loop/turn";
import type { ChatAgentInput } from "../../src/core/ports/types";

/**
 * A run input carrying a real identity. The runner refuses to mint one: a run whose traceId, sessionId and
 * runId were invented on its behalf emits events that correlate to nothing, and the caller never learns it
 * forgot — so tests state the identity the way production does rather than leaning on a default.
 */
export function runInput(
  messages: Array<ChatAgentInput["messages"][number] | { role: "user"; content: string; id?: string }>,
): ChatAgentInput & { traceContext: RunTrace } {
  return {
    messages: messages.map((message): ChatAgentInput["messages"][number] => {
      if (message.role === "assistant") return message;
      return {
        ...message,
        content: typeof message.content === "string"
          ? [{ kind: "text" as const, text: message.content }]
          : message.content,
      };
    }),
    traceContext: {
      traceId: newTraceId(),
      sessionId: `session-${newTraceId()}`,
      runId: `run-${newTraceId()}`,
    },
  };
}
