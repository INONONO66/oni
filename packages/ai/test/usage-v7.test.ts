import { describe, expect, test } from "bun:test";
import { useStreamCapture } from "./helpers/stream-capture";

/**
 * ai 7 reports cache and reasoning counts only inside the nested
 * `inputTokenDetails`/`outputTokenDetails` objects; the flat v6 fields are
 * gone. Accounting must read the nested details exactly, never fold a real
 * count to zero.
 */
describe("usage accounting under the ai 7 nested token details", () => {
  const capture = useStreamCapture();

  test("cache and reasoning totals match the nested v7 details exactly", async () => {
    capture.stream([
      { type: "start-step" },
      { type: "text-start", id: "txt_1" },
      { type: "text-delta", id: "txt_1", text: "answer" },
      { type: "text-end", id: "txt_1" },
      {
        type: "finish-step",
        finishReason: "stop",
        usage: {
          inputTokens: 120,
          outputTokens: 50,
          totalTokens: 170,
          inputTokenDetails: { noCacheTokens: 90, cacheReadTokens: 20, cacheWriteTokens: 10 },
          outputTokenDetails: { textTokens: 44, reasoningTokens: 6 },
        },
      },
      { type: "finish", finishReason: "stop" },
    ]);

    const outcome = await capture.run();

    expect(outcome).toMatchObject({
      type: "stop",
      evidence: {
        usageProvenance: "reported",
        usage: {
          inputTokens: 120,
          outputTokens: 50,
          reasoningTokens: 6,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
        },
      },
    });
  });

  test("a second step accumulates nested cache reads instead of overwriting them", async () => {
    const step = (cacheReadTokens: number) =>
      ({
        type: "finish-step",
        finishReason: "stop",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          inputTokenDetails: { cacheReadTokens, cacheWriteTokens: 0 },
          outputTokenDetails: { reasoningTokens: 2 },
        },
      }) as const;
    capture.stream([
      { type: "start-step" },
      step(30),
      { type: "start-step" },
      step(40),
      { type: "finish", finishReason: "stop" },
    ]);

    const outcome = await capture.run();

    expect(outcome).toMatchObject({
      type: "stop",
      evidence: {
        usage: {
          inputTokens: 200,
          outputTokens: 20,
          reasoningTokens: 4,
          cacheReadTokens: 70,
          cacheWriteTokens: 0,
        },
      },
    });
  });
});
