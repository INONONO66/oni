import { describe, expect, test } from "bun:test";
import { useStreamCapture } from "./helpers/stream-capture";

describe("run stream stop conditions", () => {
  const capture = useStreamCapture();

  test.each([
    { toolChoice: "required" as const },
    { toolChoice: undefined },
  ])("forwards choice and caps every attempt at one step: %s", async (input) => {
    await capture.run(input);
    expect(capture.args.toolChoice).toBe(input.toolChoice);
    expect(capture.args.maxRetries).toBe(0);
    expect(capture.stepCount).toBe(1);
    expect(capture.args.stopWhen).toHaveLength(1);
    const cap = capture.condition(0);
    expect(cap({ steps: [] })).toBe(false);
    expect(cap({ steps: [{}] })).toBe(true);
    expect(cap({ steps: [{}, {}] })).toBe(false);
    expect(cap({ steps: Array.from({ length: 23 }, () => ({})) })).toBe(false);
  });

  test("window yield reads the last step and includes the exact threshold", async () => {
    await capture.run({ yieldAtInputTokens: 800 });
    expect(capture.args.stopWhen).toHaveLength(2);
    const window = capture.condition(1);
    for (const [inputTokens, expected] of [
      [799, false],
      [800, true],
      [900, true],
    ] as const) {
      expect(window({ steps: [{ usage: { inputTokens } }] })).toBe(expected);
    }
    expect(
      window({ steps: [{ usage: { inputTokens: 900 } }, { usage: { inputTokens: 700 } }] }),
    ).toBe(false);
    expect(window({ steps: [{}] })).toBe(false);
    expect(window({ steps: [] })).toBe(false);
  });

  test("steering reads live state rather than a construction-time snapshot", async () => {
    let pending = false;
    await capture.run({ shouldYield: () => pending });
    expect(capture.args.stopWhen).toHaveLength(2);
    const steering = capture.condition(1);
    expect(steering({ steps: [] })).toBe(false);
    pending = true;
    expect(steering({ steps: [] })).toBe(true);
    pending = false;
    expect(steering({ steps: [] })).toBe(false);
  });

  test("orders steering after the window yield", async () => {
    await capture.run({ yieldAtInputTokens: 800, shouldYield: () => true });
    const conditions = capture.args.stopWhen;
    expect(conditions).toHaveLength(3);
    expect(capture.condition(0)({ steps: [] })).toBe(false);
    expect(capture.condition(1)({ steps: [] })).toBe(false);
    expect(capture.condition(2)({ steps: [] })).toBe(true);
  });
});
