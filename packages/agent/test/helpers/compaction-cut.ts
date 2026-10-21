/** #1348: the evidence history and execution input shared by the compaction cut suites. */
import { Effect } from "effect";
import type { Message } from "@oni/protocol";
import type { executeCompaction } from "../../src/plugins/compaction/execute-cut";

/** An assistant message `id` in `sessionID` carrying one completed `read` call with 900 bytes of evidence output. */
export function evidenceAssistant(sessionID: string, id: string): Message.WithParts {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 1 },
      parentID: "",
      modelID: "model",
      providerID: "provider",
      agent: "resident",
      path: { cwd: "/", root: "/" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: `${id}-tool`,
        sessionID,
        messageID: id,
        type: "tool",
        callID: `${id}-call`,
        tool: "read",
        state: {
          status: "completed",
          input: { path: id },
          output: "evidence ".repeat(100),
          title: "read",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ],
  };
}

type ExecutionInput = Parameters<typeof executeCompaction>[0];

/** A two-message `yield` compaction over `executor`, protecting one tail message and recording event names into `observed`. */
export function compactionExecutionInput(
  executor: ExecutionInput["executor"],
  observed: string[],
  history: readonly Message.WithParts[],
): ExecutionInput {
  return {
    history: [...history],
    executor,
    options: {
      contextWindowTokens: 1000,
      protectRecentMessages: 1,
      onSummarize: () => Effect.promise(async () => "summary"),
    },
    identity: { traceId: "trace", sessionId: "session-1" },
    dispatch: { trigger: "yield" },
    events: {
      publish(event) {
        observed.push(event.name);
      },
    },
  };
}
