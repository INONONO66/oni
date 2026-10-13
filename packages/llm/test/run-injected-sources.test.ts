import { expect, test } from "bun:test";
import { LlmCall, type Message } from "@openomni/protocol";
import type { StreamEvent } from "../src/processor/stream-events";
import { run } from "./helpers/native";
import { collector } from "./helpers/observation";
import { FIXED_NOW, fixedNow, sequentialIds } from "./helpers/fixtures";

/**
 * run() reads no ambient clock or entropy. Every emitted timestamp and
 * identity comes from the injected `now`/`id` sources, so a fixed stub yields
 * exact values — identical inputs produce identical outputs.
 */
test("run() stamps every time and identity from the injected sources", async () => {
  const events = collector();
  const messages: Message.WithParts[] = [];
  const outcome = await run(
    {
      authFilePath: "/nonexistent/openomni-test/auth.json",
      messages: [],
      tools: [],
      model: { id: "model", name: "model", providerID: "provider" },
      now: fixedNow,
      id: sequentialIds("entropy"),
      trace: { traceId: "trace-injected", sessionId: "session-injected", runId: "run-injected" },
      events,
    },
    {
      onMessage: (message) => {
        messages.push(message);
      },
      onToolCall: () => undefined,
      onToolResult: () => undefined,
    },
    {
      createStream: async () => ({
        fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          yield { type: "text-start" };
          yield { type: "text-delta", text: "hi" };
          yield { type: "text-end" };
          yield { type: "finish" };
        })(),
      }),
    },
  );

  expect(outcome.type).toBe("stop");
  const final = messages.at(-1);
  expect(final?.info.id).toBe("msg-entropy-1");
  expect(final?.info.time.created).toBe(FIXED_NOW);
  const textPart = final?.parts.find((part) => part.type === "text");
  expect(textPart?.id).toBe("entropy-2");
  if (textPart?.type === "text") expect(textPart.time?.start).toBe(FIXED_NOW);
  expect(events.named(LlmCall.Events.Started.name)).toMatchObject([{ time: FIXED_NOW }]);
  // A constant clock proves durationMs is injected-clock arithmetic, not wall time.
  expect(events.named(LlmCall.Events.Completed.name)).toMatchObject([
    { time: FIXED_NOW, durationMs: 0 },
  ]);
});
