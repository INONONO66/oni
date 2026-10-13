import { describe, expect, test } from "bun:test";
import { useStreamCapture } from "./helpers/stream-capture";
import { capturingSink } from "./helpers/processor";

/**
 * ai 7 stream-part vocabulary crosses the SDK boundary unchanged except for
 * the step markers (`start-step`/`finish-step` become `step-start`/
 * `step-finish`): the processor must fold the v7 stream into the identical
 * ordered part sequence the transcript always carried.
 */
describe("model stream under the ai 7 part vocabulary", () => {
  const capture = useStreamCapture();

  test("yields the same ordered StreamEvent sequence for a v7 stream", async () => {
    const output = capturingSink();
    capture.stream([
      { type: "start" },
      { type: "start-step" },
      { type: "reasoning-start", id: "r_1" },
      { type: "reasoning-delta", id: "r_1", text: "weighing options" },
      { type: "reasoning-end", id: "r_1" },
      { type: "text-start", id: "txt_1" },
      { type: "text-delta", id: "txt_1", text: "hello " },
      { type: "text-delta", id: "txt_1", text: "world" },
      { type: "text-end", id: "txt_1" },
      {
        type: "finish-step",
        finishReason: "stop",
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { reasoningTokens: 3 },
        },
      },
      { type: "finish", finishReason: "stop" },
    ]);

    const outcome = await capture.run({}, output.sink);

    expect(outcome.type).toBe("stop");
    const message = output.messages.at(-1);
    expect(message).toBeDefined();
    expect((message?.parts ?? []).map((part) => part.type)).toEqual([
      "step-start",
      "reasoning",
      "text",
      "step-finish",
    ]);
    const [, reasoning, text, stepFinish] = message?.parts ?? [];
    expect(reasoning).toMatchObject({ type: "reasoning", text: "weighing options" });
    expect(text).toMatchObject({ type: "text", text: "hello world" });
    expect(stepFinish).toMatchObject({
      type: "step-finish",
      reason: "stop",
      tokens: { input: 11, output: 7, reasoning: 3, cache: { read: 0, write: 0 } },
    });
  });
});
