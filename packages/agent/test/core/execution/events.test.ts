import { describe, expect, test } from "bun:test";
import { RunEvents } from "../../../src/core/turn";
import { Operational, type PlainObject } from "@openomni/protocol";
import { z } from "zod";
import { createBudgetState, publishBudgetTelemetry } from "../../../src/core/budget";
import { collector } from "../../helpers/observation-collector";
import { TEST_BUDGET } from "../../helpers/approval-policy";
describe("RunEvents BusEvents", () => {
  const base = { traceId: "test-trace-id", sessionId: "s1", time: 1 };
  const now = () => 1;

  test("TurnStart parses", () => {
    expect(() => RunEvents.TurnStart.schema.parse({ ...base, turnIndex: 0 })).not.toThrow();
  });

  test("published run events round-trip actorId through the schema", () => {
    const actorId = "run-actor-1";
    const parsed = RunEvents.TurnStart.schema.parse({ ...base, actorId, turnIndex: 0 });
    expect(parsed.actorId).toBe(actorId);

    const retried = RunEvents.ErrorRetry.schema.parse({
      ...base,
      actorId,
      attempt: 2,
      maxAttempts: 3,
      error: "rate limit",
      reason: "transient_error",
      backoffMs: 2000,
    });
    expect(retried.actorId).toBe(actorId);
  });

  test("TurnComplete parses", () => {
    expect(() =>
      RunEvents.TurnComplete.schema.parse({
        ...base,
        turnIndex: 0,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    ).not.toThrow();
  });

  test("TurnComplete requires total usage", () => {
    expect(() =>
      RunEvents.TurnComplete.schema.parse({
        ...base,
        turnIndex: 0,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    ).toThrow(z.ZodError);
  });

  test("tool execution events are not duplicated under RunEvents", () => {
    expect("ToolInvoked" in RunEvents).toBe(false);
    expect("ToolBlocked" in RunEvents).toBe(false);
  });

  test.each([
    { turns: 20, event: Operational.Events.Warn, status: "warning" },
    { turns: 15, event: Operational.Events.Info, status: "reassurance" },
  ])("budget $status uses the operational event contract", ({ turns, event, status }) => {
    const events = collector();
    publishBudgetTelemetry({ ...createBudgetState(now), turns }, base, events, now, TEST_BUDGET);
    expect(events.events).toHaveLength(1);
    const parsed = event.schema.parse(events.named(event.name)[0]);
    expect(parsed).toMatchObject({
      traceId: base.traceId,
      sessionId: base.sessionId,
      component: "agent.budget",
      context: { type: status },
    });
  });

  test("CompactionStarted parses, with and without measurement", () => {
    expect(() =>
      RunEvents.CompactionStarted.schema.parse({
        ...base,
        messagesBefore: 20,
        contextTokens: 180_000,
        trigger: "threshold",
        summarizer: false,
      }),
    ).not.toThrow();
    expect(() =>
      RunEvents.CompactionStarted.schema.parse({
        ...base,
        messagesBefore: 20,
        trigger: "yield",
        summarizer: true,
      }),
    ).not.toThrow();
  });

  test("CompactionStarted rejects an unknown trigger", () => {
    expect(() =>
      RunEvents.CompactionStarted.schema.parse({
        ...base,
        messagesBefore: 20,
        trigger: "manual",
        summarizer: false,
      }),
    ).toThrow(z.ZodError);
  });

  test("CompactionCompleted parses every outcome; rejects unknown ones", () => {
    for (const outcome of [
      "cut",
      "reduced",
      "nothing_reclaimed",
      "no_user_boundary",
      "failed",
    ] as const) {
      expect(() =>
        RunEvents.CompactionCompleted.schema.parse({
          ...base,
          outcome,
          messagesBefore: 20,
          messagesAfter: 5,
          removedCount: 15,
          elidedChars: 0,
        }),
      ).not.toThrow();
    }
    expect(() =>
      RunEvents.CompactionCompleted.schema.parse({
        ...base,
        outcome: "partial",
        messagesBefore: 20,
        messagesAfter: 5,
        removedCount: 15,
        elidedChars: 0,
      }),
    ).toThrow(z.ZodError);
  });

  /** One field at a time, or relaxing either alone still throws on the other. */
  test.each(["reason", "backoffMs"] as const)("ErrorRetry requires %s", (field) => {
    const payload: PlainObject = {
      ...base,
      attempt: 2,
      maxAttempts: 3,
      error: "rate limit",
      reason: "transient_error",
      backoffMs: 2000,
    };
    delete payload[field];

    expect(() => RunEvents.ErrorRetry.schema.parse(payload)).toThrow(z.ZodError);
  });

  test("ErrorRetry parses", () => {
    expect(() =>
      RunEvents.ErrorRetry.schema.parse({
        ...base,
        attempt: 2,
        maxAttempts: 3,
        error: "rate limit",
        reason: "transient_error",
        backoffMs: 2000,
      }),
    ).not.toThrow();
  });
});
