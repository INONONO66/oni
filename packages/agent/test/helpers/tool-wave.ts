/** #1348: the parallel tool-wave fixtures shared by the wave ordering and timing suites. */
import type { Message } from "@openomni/protocol";
import { createAssistantMessage } from "../../src/core/message-factory";
import type { LlmSink as Sink } from "../../src/core/llm";
import { buildTurn, createRunState } from "../../src/core/turn";
import type { ObservedChatAgentConfig } from "../../src/core/types";
import { messageSource } from "./message-source";
import { runInput } from "./run-input";

/** An empty assistant message in `sessionId` carrying one pending `timed` tool part per call id. */
export function pendingTimedAssistant(sessionId: string, ids: readonly string[]): Message.WithParts {
  const message = createAssistantMessage("", "", sessionId, messageSource);
  return {
    ...message,
    parts: ids.map((id) => ({
      id: `${id}:part`,
      sessionID: sessionId,
      messageID: message.info.id,
      type: "tool",
      callID: id,
      tool: "timed",
      state: { status: "pending", input: {} },
    })),
  };
}

/** Builds the ready turn for `config` over an empty run input and parks pending `timed` calls `A` and `B` on its assistant. */
export function readyWaveTurn(config: ObservedChatAgentConfig, sessionId: string, sink?: Sink) {
  const input = runInput([]);
  const state = createRunState(input, messageSource);
  const built = buildTurn(
    state,
    config,
    { providerID: "test", id: "test", name: "test" },
    undefined,
    input.traceContext,
    messageSource,
    sink,
  );
  if (built.type !== "ready") throw new Error("turn unavailable");
  const turn = built.turn;
  turn.turnAssistant.message = pendingTimedAssistant(sessionId, ["A", "B"]);
  return { state, turn };
}
