import { expect, test } from "bun:test";
import { run } from "./helpers/native";
import type { StreamEvent } from "../src/processor/stream-events";

for (const visible of ["none", "text", "tool"] as const) {
  test(`one provider attempt retains ${visible} visibility and billed failure`, async () => {
    let calls = 0;
    const outcome = await run(
      {
        authFilePath: "/nonexistent/openomni-test/auth.json",
        messages: [],
        tools: [],
        model: { id: "test", name: "test", providerID: "test" },
        trace: { traceId: "trace", sessionId: "session", runId: "run" },
        events: { publish: () => undefined },
      },
      { onMessage: () => undefined, onToolCall: () => undefined, onToolResult: () => undefined },
      {
        createStream: async () => {
          calls += 1;
          return {
            fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
              if (visible === "text") yield { type: "text-delta", text: "visible" };
              if (visible === "tool")
                yield { type: "tool-call", toolCallId: "call", toolName: "read", input: {} };
              yield { type: "step-finish", usage: { inputTokens: 17, outputTokens: 2 } };
              throw Object.assign(new Error("overloaded"), {
                isRetryable: true,
                statusCode: 529,
                responseHeaders: { "retry-after-ms": "0" },
              });
            })(),
          };
        },
      },
    );
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({
      type: "error",
      error: {
        visibleOutput: visible !== "none", usage: { inputTokens: 17, outputTokens: 2 },
      },
    });
  });
}
