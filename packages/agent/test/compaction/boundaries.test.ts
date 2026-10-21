import { describe, expect, it } from "bun:test";
import type { Message } from "@oni/protocol";
import { Cause, Effect, Exit } from "effect";
import { planAnchoredCut } from "../../src/plugins/compaction/candidate";
import { createCompactionPlan, restoreCompactionProjection } from "../../src/plugins/compaction/durable";
import { CompactionSession } from "../../src/plugins/compaction/speculate";
import { AgentInvariantViolation } from "../../src/core/ports/failure";
import { isolated } from "../helpers/isolated";
import { withSummarizerDeadline } from "../../src/plugins/compaction/summary";
import { textMessage } from "../helpers/messages";


function history() {
  return [
    textMessage("assistant", "evidence ".repeat(100), "session", "first"),
    textMessage("user", "tail", "session", "last"),
  ];
}
describe("compaction boundary integrity", () => {
  it("interrupts a summarizer before invoking it", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const summarize = withSummarizerDeadline(() => {
      called = true;
      return Effect.succeed("summary");
    }, 1000, controller.signal);
    const exit = await isolated(Effect.exit(summarize([], undefined, { maxInputTokens: 10, maxOutputTokens: 10, contextWindowTokens: 100 })));
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(called).toBe(false);
  });

  it("rejects empty or entirely retained histories", () => {
    const prior = history();
    expect(() => createCompactionPlan([], prior, 10)).toThrow(AgentInvariantViolation);
    expect(() => createCompactionPlan(prior, prior, 10)).toThrow(AgentInvariantViolation);
  });

  it("rejects changed revert evidence", () => {
    const prior = history();
    const plan = createCompactionPlan(prior, prior.slice(1), 10);
    const changed = {
      ...plan.record,
      revert: { ...plan.record.revert, removedEntries: [] },
    };
    expect(() => restoreCompactionProjection(plan.projection, changed)).toThrow(AgentInvariantViolation);
    expect(restoreCompactionProjection(plan.projection, plan.record)).toEqual(prior);
  });

  it("fingerprints reasoning and step boundaries rather than just visible text", () => {
    const messages = history();
    const first = messages[0];
    if (first === undefined) throw new Error("missing fixture");
    const before = planAnchoredCut(messages, 1)?.prefixFingerprint;
    first.parts.push({
      id: "reasoning",
      messageID: first.info.id,
      sessionID: first.info.sessionID,
      type: "reasoning",
      text: "reason",
      signature: "signature",
      time: { start: 1 },
    });
    const reasoned = planAnchoredCut(messages, 1)?.prefixFingerprint;
    expect(reasoned).not.toBe(before);
    first.parts.push({
      id: "step",
      messageID: first.info.id,
      sessionID: first.info.sessionID,
      type: "step-start",
    });
    const started = planAnchoredCut(messages, 1)?.prefixFingerprint;
    expect(started).not.toBe(reasoned);
    first.parts.push({
      id: "finish",
      messageID: first.info.id,
      sessionID: first.info.sessionID,
      type: "step-finish",
      reason: "stop",
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(planAnchoredCut(messages, 1)?.prefixFingerprint).not.toBe(started);
  });

  it("consumes candidates and disables further speculative work", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;
          const session = new CompactionSession({
            protectRecentMessages: 1,
            summarize: (messages: Message.WithParts[]) => {
              calls += 1;
              return Effect.succeed(
                messages.map((message: Message.WithParts) => message.info.id).join(","),
              );
            },
          });
          yield* session.prepare(history(), 70, 60, 1000);
          expect(session.inFlight()).toBe(true);
          yield* session.settled();
          expect(session.candidate()?.anchorBody).toBe("first");
          expect(session.inFlight()).toBe(false);
          session.consume();
          expect(session.candidate()).toBeUndefined();
          yield* session.disable();
          yield* session.prepare(history(), 70, 60, 1000);
          yield* session.settled();
          expect(calls).toBe(1);
        }),
      ),
    ));
});
