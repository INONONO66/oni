import { describe, expect, it } from "bun:test";
import type { PlainValue } from "@openomni/protocol";
import type { SessionRunnerResult } from "../src/core/session/run";
import { sessionRunnerResultFromValue, sessionRunnerResultValue } from "../src/core/journal/commit";

const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };

function roundTrip(result: SessionRunnerResult): SessionRunnerResult | undefined {
  return sessionRunnerResultFromValue(sessionRunnerResultValue(result));
}

describe("session result wire contract", () => {
  const results: SessionRunnerResult[] = [
    { kind: "result", text: "done" },
    { kind: "result", text: "", finishReason: "stop", usage },
    {
      kind: "result",
      text: "",
      finishReason: "max-steps",
      usage: {
        ...usage,
        reasoningTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 4,
      },
    },
    { kind: "result", text: "", finishReason: "stalled" },
    { kind: "interrupted" },
    { kind: "interrupted", text: "partial" },
    { kind: "waiting", text: "", reason: "live_wait", alarmIds: ["alarm"] },
    { kind: "error", text: "failed" },
    { kind: "error", text: "failed", reported: true },
  ];
  it.each(results)("round-trips $kind without adding fields", (result) => {
    expect(roundTrip(result)).toEqual(result);
  });

  it("does not persist the invocation-local cause", () => {
    expect(roundTrip({ kind: "error", text: "failed", cause: new Error("private") })).toEqual({
      kind: "error",
      text: "failed",
    });
  });

  const invalid: PlainValue[] = [
    null,
    [],
    "result",
    {},
    { kind: "other", text: "" },
    { kind: "result" },
    { kind: "result", text: 1 },
    { kind: "result", text: "", finishReason: "error" },
    { kind: "result", text: "", usage: null },
    { kind: "result", text: "", usage: { inputTokens: 1, outputTokens: 2 } },
    { kind: "result", text: "", usage: { ...usage, extra: 1 } },
    { kind: "result", text: "", extra: 1 },
    { kind: "interrupted", text: null },
    { kind: "interrupted", extra: 1 },
    { kind: "error", text: "", reported: false },
    { kind: "error" },
    { kind: "error", text: "", cause: "private" },
    { kind: "waiting", text: "", reason: "other", alarmIds: ["alarm"] },
    { kind: "waiting", text: "", reason: "live_wait", alarmIds: [] },
    { kind: "waiting", text: "", reason: "live_wait", alarmIds: [1] },
    { kind: "waiting", text: "", reason: "live_wait", alarmIds: ["alarm"], extra: 1 },
  ];
  it.each(invalid.map((value) => ({ value })))("rejects malformed durable values %#", ({
    value,
  }) => {
    expect(sessionRunnerResultFromValue(value)).toBeUndefined();
  });

  it.each([
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ])("requires finite numeric %s", (field) => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "1", null]) {
      expect(
        sessionRunnerResultFromValue({
          kind: "result",
          text: "",
          usage: { ...usage, [field]: value },
        }),
      ).toBeUndefined();
    }
  });
});
