import { expect, test } from "bun:test";
import { PlainValueSchema, type PlainObject, type PlainValue } from "@openomni/protocol";
import { run, type RunInput } from "./helpers/native";
import type { StreamEvent } from "../src/processor/stream-events";

async function returnedCalls(
  names: readonly string[],
  wireNames: readonly string[],
  failure?: Error,
) {
  const calls: { id: string; tool: string; input: PlainValue }[] = [];
  const results: string[] = [];
  let states: string[] = [];
  let attempts = 0;
  const outcome = await run(
    {
      model: { id: "model", providerID: "fixture", name: "model" },
      messages: [],
      tools: names.map((name) => ({ name, inputSchema: { type: "object" } })),
      trace: { traceId: "trace", sessionId: "session", runId: "run" },
      events: { publish: () => undefined },
    },
    {
      onMessage(message) {
        states = message.parts
          .filter((part) => part.type === "tool")
          .map((part) => part.state.status);
      },
      onToolCall(call) {
        calls.push({ id: call.id, tool: call.tool, input: PlainValueSchema.parse(call.input) });
      },
      onToolResult(result) {
        results.push(result.toolCallId);
      },
    },
    {
      async createStream() {
        attempts += 1;
        return {
          fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
            for (const [index, name] of wireNames.entries()) {
              const input: PlainObject = { slot: index };
              yield { type: "tool-call", toolCallId: `call-${index}`, toolName: name, input };
            }
            if (failure !== undefined) throw failure;
            yield {
              type: "step-finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 10, outputTokens: 2 },
            };
          })(),
        };
      },
    },
  );
  return { outcome, calls, results, states, attempts };
}

test("a provider step returns pending invocation data without fabricating tool results", async () => {
  const observed = await returnedCalls(["lookup"], ["lookup"]);
  expect(observed.outcome).toMatchObject({ type: "stop" });
  expect(observed.calls).toEqual([{ id: "call-0", tool: "lookup", input: { slot: 0 } }]);
  expect(observed.results).toEqual([]);
  expect(observed.states).toEqual(["pending"]);
  expect(observed.attempts).toBe(1);
});

test("a failed provider attempt settles its unfinished call as an error rather than executing it", async () => {
  const observed = await returnedCalls(["lookup"], ["lookup"], new Error("provider failure"));
  expect(observed.outcome.type).toBe("error");
  expect(observed.states).toEqual(["error"]);
  expect(observed.attempts).toBe(1);
});

test("sanitized provider names return the original dotted invocation name", async () => {
  const observed = await returnedCalls(["message.send"], ["message_send"]);
  expect(observed.calls).toEqual([{ id: "call-0", tool: "message.send", input: { slot: 0 } }]);
  expect(observed.results).toEqual([]);
});

test("colliding MCP wire names retain independent positional invocations", async () => {
  const observed = await returnedCalls(["srv.x.y", "srv_x_y"], ["srv_x_y", "srv_x_y_2"]);
  expect(observed.calls).toEqual([
    { id: "call-0", tool: "srv.x.y", input: { slot: 0 } },
    { id: "call-1", tool: "srv_x_y", input: { slot: 1 } },
  ]);
  expect(observed.states).toEqual(["pending", "pending"]);
});

test("the provider input contract exposes no tool execution capability", () => {
  const exposesExecutor: "toolExecutor" extends keyof RunInput ? true : false = false;
  expect(exposesExecutor).toBe(false);
});
