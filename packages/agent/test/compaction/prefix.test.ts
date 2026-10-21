import { expect, test } from "bun:test";
import type { Message } from "@oni/protocol";
import { Effect } from "effect";
import { Compaction, CompactionSession } from "../../src/plugins/compaction";
import { evidenceAssistant } from "../helpers/compaction-cut";
import { messageSequence } from "../helpers/messages";
import { isolated } from "../helpers/isolated";

test.each(["synchronous", "speculative"] as const)(
  "%s summary receives original users, anchor, and completed tool bytes in order",
  (mode) => isolated(Effect.scoped(Effect.gen(function* () {
    const sequence = messageSequence("prefix");
    const anchor = sequence.user("prior\nanchor\t");
    const part = anchor.parts[0];
    if (part?.type !== "text") throw new TypeError("expected text fixture");
    part.metadata = { compactionAnchor: true, anchorBody: "prior" };
    const messages = [
      anchor, sequence.user("original\nuser\t"),
      evidenceAssistant("prefix", "tool"), sequence.user("tail"),
    ];
    const original = structuredClone(messages);
    const calls: Message.WithParts[][] = [];
    const summarize = (input: Message.WithParts[]) => Effect.sync(() => {
      calls.push(structuredClone(input));
      return "summary";
    });
    if (mode === "speculative") {
      const session = new CompactionSession({ protectRecentMessages: 1, summarize });
      yield* session.prepare(messages, 9000, 800, 1000);
      yield* session.settled();
      expect(session.candidate()).toBeDefined();
    } else {
      const result = yield* Compaction.compact(messages, {
        contextWindowTokens: 1000, protectRecentMessages: 1,
        elideToolOutputs: { minOutputChars: 100, keepHeadChars: 10 },
        onSummarize: summarize,
      }, { traceId: "prefix", sessionId: "prefix" }, { publish: () => undefined }, {
        trigger: "threshold", measuredTokens: 9000,
      });
      expect(result.compacted).toBe(true);
    }
    expect(calls).toEqual([original.slice(0, -1)]);
    expect(messages).toEqual(original);
  }))),
);

test("an overflow-sized prefix still yields a summary through the bounded input", () =>
  isolated(Effect.gen(function* () {
    const sequence = messageSequence("overflow");
    const finding = sequence.assistant("recent finding");
    const messages = [
      sequence.user("goal"), sequence.assistant("evidence ".repeat(2000)), finding, sequence.user("tail"),
    ];
    const calls: Message.WithParts[][] = [];
    const result = yield* Compaction.compact(messages, {
      contextWindowTokens: 1000, protectRecentMessages: 1,
      onSummarize: (input) => Effect.sync(() => { calls.push(input); return "summary"; }),
    }, { traceId: "overflow", sessionId: "overflow" }, { publish: () => undefined }, {
      trigger: "threshold", measuredTokens: 5000,
    });
    expect(calls).toEqual([[finding]]);
    expect(result.summarizerFailed).toBeUndefined();
    expect(result.messages[0]?.parts[0]).toMatchObject({ metadata: { anchorBody: "summary" } });
  })));

test("speculation does not summarize a prefix containing only preserved users", () =>
  isolated(Effect.scoped(Effect.gen(function* () {
    const sequence = messageSequence("users-only");
    let calls = 0;
    const session = new CompactionSession({
      protectRecentMessages: 1,
      summarize: () => Effect.sync(() => { calls += 1; return "summary"; }),
    });
    yield* session.prepare([sequence.user("one"), sequence.user("tail")], 900, 800, 1000);
    yield* session.settled();
    expect(calls).toBe(0);
    expect(session.candidate()).toBeUndefined();
  }))));
