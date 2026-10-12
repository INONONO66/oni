import { expect, it } from "bun:test";
import { Effect } from "effect";
import type { Message } from "@openomni/protocol";
import { executeCompaction } from "../../src/plugins/compaction/execute-cut";
import type { Executor } from "../../src/core/gate/decide";
import { isolated } from "../helpers/isolated";

function assistant(id: string): Message.WithParts {
  return {
    info: {
      id,
      sessionID: "execute-cut-failure",
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
        sessionID: "execute-cut-failure",
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

function executionInput(executor: Executor, observed: string[]): Parameters<typeof executeCompaction>[0] {
  return {
    history: [assistant("first"), assistant("last")],
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

it("fails with a catchTag-able CompactionExecutionError when the durable output no longer matches", async () => {
  // Given: an executor that reports success with output the compaction never produced.
  const tampering: Executor = {
    run: () => Effect.succeed({ terminal: "executed", value: "tampered" }),
  };
  const observed: string[] = [];

  // When: the typed failure is recovered through Effect.catchTag, not instanceof sniffing.
  const recovered = await isolated(
    executeCompaction(executionInput(tampering, observed)).pipe(
      Effect.map(() => "unexpected success"),
      Effect.catchTag("CompactionExecutionError", (error) =>
        Effect.succeed(`caught:${error._tag}:${error.reason}|${error.message}`),
      ),
    ),
  );

  // Then: the invalid_output refusal is a typed failure whose message carries the reason, and held observations never fired.
  expect(recovered).toBe("caught:CompactionExecutionError:invalid_output|compaction execution refused: invalid_output");
  expect(observed).toEqual([]);
});
