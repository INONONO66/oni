import { Effect } from "effect";
import { isolated } from "../helpers/isolated";
import { describe, expect, it } from "bun:test";
import type { Message, PlainValue } from "@openomni/protocol";
import { z } from "zod";
import { RunEvents } from "../../src/core/turn";
import { Bus } from "../helpers/bus";
import { Compaction } from "../../src/plugins/compaction/compact";
import type { ResolvedCompactionOptions, SummarizationBudget } from "../../src/plugins/compaction/contract";
import {
  estimateMessagesTokens,
  isIneffectiveCompaction,
  prepareSummarizerInput,
} from "../../src/plugins/compaction/estimate";
import { captureBusEvents } from "../helpers/bus-event";
import { completedToolPart, messageSequence } from "../helpers/messages";
import { AgentFailure } from "../../src/core/failure";
import { createRunState, recordCallContext } from "../../src/core/turn";
import { CompactionRun } from "../../src/plugins/compaction/policy";
import { executeCompaction } from "../../src/plugins/compaction/execute-cut";
import { recoveryRecording } from "../helpers/effect-g3r";
import { runInput } from "../helpers/run-input";
import { testMessageSource } from "../helpers/message-source";
import { collector } from "../helpers/observation-collector";
import { runTestAgent } from "../helpers/effect-g3";
import { windowedLlm } from "../helpers/mock-llm";
import { assistantWithParts } from "../helpers/messages";

/** Compaction rewrites a run's history; the record carries that run's trace. */
const TEST_TRACE_ID = "trace-compaction-test";

// The discarded content must outweigh the anchor render.
const {
  user: makeUserMessage,
  assistant: makeAssistantMessage,
  nextId,
} = messageSequence("test", `\n${"filler ".repeat(50)}`);

function makeToolAssistantMessage(text: string, callID: string): Message.WithParts {
  const base = makeAssistantMessage(text);
  const toolPart = completedToolPart(base, "file contents", callID, { path: "/tmp/a" });
  return { info: base.info, parts: [...base.parts, toolPart] };
}

/** `count` messages alternating user/assistant, each naming its index. */
function alternating(count: number): Message.WithParts[] {
  return Array.from({ length: count }, (_: undefined, i: number) =>
    i % 2 === 0 ? makeUserMessage(`user ${i}`) : makeAssistantMessage(`assistant ${i}`),
  );
}

function textsOf(messages: readonly Message.WithParts[]): string[] {
  return messages.flatMap((m: Message.WithParts) =>
    m.parts
      .filter((p: Message.Part): p is Message.TextPart => p.type === "text")
      .map((p: Message.TextPart) => p.text),
  );
}

/** One threshold-triggered compaction over `messages` observed on the shared bus. */
function compactThreshold(messages: Message.WithParts[], options: ResolvedCompactionOptions) {
  return isolated(
    Compaction.compact(messages, options, { traceId: TEST_TRACE_ID, sessionId: "test" }, Bus, {
      trigger: "threshold",
    }),
  );
}

// Shared with rejection tests so the anchor metadata assertion cannot silently weaken.
function parseKeptWindow(value: Message.MetadataValue | PlainValue | readonly PlainValue[] | undefined) {
  return z.array(z.object({ time: z.number(), text: z.string() })).parse(value);
}

describe("Compaction", () => {
  it("kept-window assertion rejects a missing timestamp", () => {
    expect(() => parseKeptWindow([{ text: "ok" }])).toThrow(z.ZodError);
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
  ])("kept-window assertion rejects a non-finite timestamp: %s", (time: number) => {
    expect(() => parseKeptWindow([{ time, text: "ok" }])).toThrow(z.ZodError);
  });

  it.each([
    { value: null },
    { value: {} },
    { value: [{ time: 1 }] },
    { value: [{ time: "1", text: "ok" }] },
  ])("kept-window assertion rejects malformed metadata: %j", ({
    value,
  }: {
    value: PlainValue | readonly PlainValue[];
  }) => {
    expect(() => parseKeptWindow(value)).toThrow(z.ZodError);
  });

  /**
   * Compaction rewrites the run's history; the record of that has to be
   * readable against the run it changed. Re-minting here left the suite green.
   */
  it("files the compaction record under the run's trace", async () => {
    const started = captureBusEvents(RunEvents.CompactionStarted);
    const completed = captureBusEvents(RunEvents.CompactionCompleted);

    try {
      await isolated(
        Compaction.compact(
          Array.from({ length: 12 }, (_unused: undefined, index: number) =>
            makeUserMessage(`message ${index}`),
          ),
          { contextWindowTokens: 1000, protectRecentMessages: 2 },
          { traceId: TEST_TRACE_ID, sessionId: "test" },
          Bus,
          { trigger: "threshold" },
        ),
      );
      const seen = [...(await started.done), ...(await completed.done)];
      expect(started.events).toHaveLength(1);
      expect(completed.events).toHaveLength(1);
      // The bracket: started + completed, both filed under the run's trace.
      expect(
        seen.filter((event: (typeof seen)[number]) => event.traceId === TEST_TRACE_ID),
      ).toHaveLength(2);
    } finally {
      started.unsubscribe();
      completed.unsubscribe();
    }
  });

  describe("shouldCompact", () => {
    it("compacts before consuming a larger configured reserve", () => {
      expect(
        Compaction.shouldCompact(50_000, {
          contextWindowTokens: 100_000,
          reserveTokens: 50_000,
        }),
      ).toBe(true);
    });

    it("moves a low-yield next round later", () => {
      expect(
        Compaction.shouldCompact(
          450,
          { contextWindowTokens: 1000 },
          { savedTokens: 50, tokensBefore: 1000 },
        ),
      ).toBe(false);
    });
  });

  describe("ineffective yield", () => {
    it("requires both the absolute and ratio floors", () => {
      expect(isIneffectiveCompaction(1024, 10_241)).toBe(true);
      expect(isIneffectiveCompaction(1024, 10_240)).toBe(false);
    });
  });

  describe("compact", () => {
    it("does not compact when messages count is within protectRecent", async () => {
      const messages = [makeUserMessage("a"), makeAssistantMessage("b")];
      const result = await compactThreshold(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 6,
      });
      expect(result.compacted).toBe(false);
      expect(result.removedCount).toBe(0);
      expect(result.messages).toHaveLength(2);
    });

    it("removes oldest non-system messages beyond protectRecent", async () => {
      const messages = alternating(10);
      const result = await compactThreshold(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 4,
      });
      expect(result.compacted).toBe(true);
      expect(result.removedCount).toBe(6);
      expect(result.messages).toHaveLength(4);
    });

    it("preserves the most recent messages", async () => {
      const messages = [
        makeUserMessage("old-1"),
        makeAssistantMessage("old-2"),
        makeUserMessage("recent-3"),
        makeAssistantMessage("recent-4"),
        makeUserMessage("recent-5"),
        makeAssistantMessage("recent-6"),
        makeUserMessage("recent-7"),
        makeAssistantMessage("recent-8"),
      ];
      const result = await compactThreshold(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 6,
      });
      expect(result.compacted).toBe(true);
      expect(result.messages).toHaveLength(6);
      const texts = textsOf(result.messages);
      expect(texts).toContain("recent-3");
      expect(texts).not.toContain("old-1");
    });

    it("passes a bounded summarizer budget contract", async () => {
      const messages = Array.from({ length: 8 }, (_: undefined, index: number) =>
        index % 2 === 0
          ? makeUserMessage(`user ${index}`)
          : makeAssistantMessage("word ".repeat(300)),
      );
      let observed:
        | { input: Message.WithParts[]; maxInputTokens: number; maxOutputTokens: number }
        | undefined;
      await isolated(
        Compaction.compact(
          messages,
          {
            contextWindowTokens: 2000,
            protectRecentMessages: 2,
            onSummarize: (
              input: Message.WithParts[],
              _previous: string | undefined,
              budget: SummarizationBudget,
            ) =>
              Effect.sync(() => {
                observed = {
                  input,
                  maxInputTokens: budget.maxInputTokens,
                  maxOutputTokens: budget.maxOutputTokens,
                };
                return "bounded";
              }),
          },
          { traceId: TEST_TRACE_ID, sessionId: "test" },
          Bus,
          { trigger: "threshold" },
        ),
      );
      expect(observed?.maxInputTokens).toBe(1000);
      expect(observed?.maxOutputTokens).toBe(1000);
      expect(estimateMessagesTokens(observed?.input ?? [])).toBeLessThanOrEqual(1000);
    });

    it("weights long base64-like runs at four times their character length", () => {
      const plain = makeAssistantMessage("a".repeat(511));
      const encoded = makeAssistantMessage("a".repeat(512));
      expect(estimateMessagesTokens([encoded]) - estimateMessagesTokens([plain])).toBeGreaterThan(
        300,
      );
      const bounded = prepareSummarizerInput([encoded], 1000);
      expect(bounded.messages).toHaveLength(0);
    });

    it("inserts summary message when onSummarize is provided", async () => {
      const messages = alternating(8);
      const result = await compactThreshold(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 4,
        onSummarize: () => Effect.sync(() => "Summary of removed messages"),
      });
      expect(result.compacted).toBe(true);
      const allTexts = textsOf(result.messages);
      expect(allTexts.some((t: string) => t.includes("Summary of removed messages"))).toBe(true);
    });

    it("does not compact when non-system messages are within protectRecent", async () => {
      const messages = [makeUserMessage("a"), makeAssistantMessage("b"), makeUserMessage("c")];
      const result = await compactThreshold(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 6,
      });
      expect(result.compacted).toBe(false);
    });
  });

  describe("summarizer input trimming (#1314)", () => {
    // The quadratic reference this replaced: re-estimate the shrinking
    // suffix with the public estimator until it fits the half-window budget.
    function quadraticReference(
      messages: readonly Message.WithParts[],
      contextWindowTokens: number,
    ): readonly Message.WithParts[] {
      const budget = Math.max(0, Math.floor(contextWindowTokens * 0.5));
      let first = 0;
      while (first < messages.length && estimateMessagesTokens(messages.slice(first)) > budget) {
        first += 1;
      }
      return messages.slice(first);
    }

    it("matches the quadratic reference on 500 individually over-budget messages", () => {
      const messages = Array.from({ length: 500 }, (_: undefined, i: number) =>
        i % 2 === 0
          ? makeUserMessage(`user ${i} ${"content ".repeat(600)}`)
          : makeAssistantMessage(`assistant ${i} ${"content ".repeat(600)}`),
      );
      const result = prepareSummarizerInput(messages, 2000);
      expect(result.messages).toEqual([...quadraticReference(messages, 2000)]);
    });

    it("matches the quadratic reference when the drop stops mid-list", () => {
      const messages = Array.from({ length: 64 }, (_: undefined, i: number) =>
        i % 2 === 0
          ? makeUserMessage(`user ${i} ${"content ".repeat(20)}`)
          : makeAssistantMessage(`assistant ${i} ${"content ".repeat(20)}`),
      );
      const result = prepareSummarizerInput(messages, 8000);
      const expected = quadraticReference(messages, 8000);
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.length).toBeLessThan(messages.length);
      expect(result.messages).toEqual([...expected]);
    });

    it("matches the quadratic reference when the kept suffix lands exactly on the budget", () => {
      // Review r1 L2: the `>` stop edge. Four 400-char user messages are 100
      // tokens each (400/4, no rounding); at a 400-token window the budget is
      // 200, so the drop stops when the suffix estimate EQUALS the budget.
      const messages = Array.from({ length: 4 }, (_: undefined, i: number) =>
        makeUserMessage(`${i}`.padEnd(400, "x")),
      );
      const result = prepareSummarizerInput(messages, 400);
      expect(result.messages).toEqual([...quadraticReference(messages, 400)]);
      expect(result.messages).toHaveLength(2);
      expect(estimateMessagesTokens(result.messages)).toBe(200);
    });

    it("returns no messages and an intact budget for zero inputs", () => {
      const result = prepareSummarizerInput([], 2000);
      expect(result.messages).toEqual([]);
      expect(result.budget.maxInputTokens).toBe(1000);
    });
  });

  describe("commit boundary invariant", () => {
    it("snaps the cutoff back to a user boundary when no summary anchors the kept window", async () => {
      // onSummarize unset (it is optional everywhere): the natural cutoff lands
      // on an assistant message, which no provider accepts as the first
      // message of a conversation. The commit must snap back to the nearest
      // user boundary instead of committing a leading-assistant window.
      const messages = [
        makeUserMessage("u0"),
        makeAssistantMessage("a1"),
        makeUserMessage("u2"),
        makeAssistantMessage("a3"),
        makeUserMessage("u4"),
        makeToolAssistantMessage("a5", "call-1"),
        makeUserMessage("u6"),
        makeAssistantMessage("a7"),
      ];
      const result = await compactThreshold(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 3,
      });
      expect(result.compacted).toBe(true);
      expect(result.messages[0]?.info.role).toBe("user");
      expect(result.removedCount).toBe(4);
      expect(result.messages).toHaveLength(4);
      // The kept tool call and its result travel in the same WithParts message:
      // message-boundary slicing cannot split the pair.
      const toolParts = result.messages.flatMap((message: Message.WithParts) =>
        message.parts.filter(
          (part: Message.Part): part is Message.ToolPart => part.type === "tool",
        ),
      );
      expect(toolParts).toHaveLength(1);
      expect(toolParts[0]?.state.status).toBe("completed");
    });

    it("refuses as a value when no valid user boundary exists — never a throw", async () => {
      // No user message at or before the cutoff: there is no boundary that can
      // anchor the kept window without a summary. The wiring review proved
      // assistant-first histories reachable from resumed child hydration, and
      // run.completion.pre is fail-closed — a throw here kills a live run over
      // housekeeping. The refusal is a value the policy records.
      const messages = Array.from({ length: 8 }, (_: undefined, i: number) =>
        makeAssistantMessage(`a${i}`),
      );
      const result = await compactThreshold(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 3,
      });
      expect(result.compacted).toBe(false);
      expect(result.blocked).toBe("no_user_boundary");
      expect(result.messages).toHaveLength(8);
    });

    it("reports nothing reclaimed when the only user boundary is the opening message", async () => {
      // Snapping lands on index 0: a cut there removes nothing, so the round is
      // a value-level no-op rather than a refusal or a zero-progress "cut".
      const completed = captureBusEvents(RunEvents.CompactionCompleted);
      try {
        const messages = [
          makeUserMessage("u0"),
          ...Array.from({ length: 5 }, (_: undefined, i: number) =>
            makeAssistantMessage(`a${i + 1}`),
          ),
        ];
        const result = await isolated(
          Compaction.compact(
            messages,
            { contextWindowTokens: 1000, protectRecentMessages: 2 },
            { traceId: TEST_TRACE_ID, sessionId: "test" },
            Bus,
            { trigger: "threshold" },
          ),
        );
        await completed.done;
        expect(result.compacted).toBe(false);
        expect(result.blocked).toBeUndefined();
        expect(result.messages).toBe(messages);
        expect(completed.events[0]?.outcome).toBe("nothing_reclaimed");
      } finally {
        completed.unsubscribe();
      }
    });

    it("reports the elision as reduced when the opening message is the only user boundary", async () => {
      const completed = captureBusEvents(RunEvents.CompactionCompleted);
      try {
        const tool = makeToolAssistantMessage("a1", "call-big");
        const toolPart = tool.parts.find(
          (part: Message.Part): part is Message.ToolPart => part.type === "tool",
        );
        if (toolPart?.state.status !== "completed") throw new Error("missing tool fixture");
        toolPart.state.output = "x".repeat(400);
        const messages = [
          makeUserMessage("u0"),
          tool,
          makeAssistantMessage("a2"),
          makeAssistantMessage("a3"),
        ];
        const result = await isolated(
          Compaction.compact(
            messages,
            {
              contextWindowTokens: 1000,
              protectRecentMessages: 2,
              elideToolOutputs: { minOutputChars: 100, keepHeadChars: 10 },
            },
            { traceId: TEST_TRACE_ID, sessionId: "test" },
            Bus,
            // Overage far above the ~80-token estimated reclaim: elision alone
            // cannot settle the round, so the cut is attempted and snaps to 0.
            { trigger: "threshold", measuredTokens: 5000 },
          ),
        );
        await completed.done;
        expect(result.compacted).toBe(true);
        expect(result.removedCount).toBe(0);
        expect(result.messages).toHaveLength(4);
        const kept = result.messages[1]?.parts.find(
          (part: Message.Part): part is Message.ToolPart => part.type === "tool",
        );
        expect(kept?.state.status === "completed" && kept.state.output).toContain(
          "[output elided by compaction: 400 chars; recall: call-big]",
        );
        expect(completed.events[0]?.outcome).toBe("reduced");
        expect(completed.events[0]?.elidedChars).toBeGreaterThan(300);
      } finally {
        completed.unsubscribe();
      }
    });

    it("keeps the natural cutoff when a summary user message anchors the window", async () => {
      // Pin: with onSummarize present, the prepended summary user message makes
      // any message-boundary cutoff provider-valid — no snap-back happens.
      const messages = [
        makeUserMessage("u0"),
        makeAssistantMessage("a1"),
        makeUserMessage("u2"),
        makeAssistantMessage("a3"),
        makeUserMessage("u4"),
        makeAssistantMessage("a5"),
        makeUserMessage("u6"),
        makeAssistantMessage("a7"),
      ];
      const result = await compactThreshold(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 3,
        onSummarize: () => Effect.sync(() => "anchored"),
      });
      expect(result.compacted).toBe(true);
      // L2: the cut span's user messages (u0, u2, u4) survive verbatim, so
      // only the two assistant messages are dropped into the anchor.
      expect(result.removedCount).toBe(2);
      expect(result.messages).toHaveLength(7);
      expect(result.messages[0]?.info.role).toBe("user");
      const texts = textsOf(result.messages);
      expect(texts).toContain("u0");
      expect(texts).toContain("u2");
      expect(texts).toContain("u4");
      expect(texts.some((t: string) => t.includes("a1"))).toBe(false);
    });

    it("threads the history session id into the summary message", async () => {
      const messages = alternating(8);
      const result = await compactThreshold(messages, {
        contextWindowTokens: 1000,
        protectRecentMessages: 4,
        onSummarize: () => Effect.sync(() => "summary"),
      });
      const summary = result.messages[0];
      expect(summary?.info.role).toBe("user");
      // History carries sessionID "test"; the summary must not introduce a
      // foreign session id into the compacted history.
      expect(summary?.info.sessionID).toBe("test");
      expect(summary?.parts[0]?.sessionID).toBe("test");
      expect(summary?.parts[0]?.messageID).toBe(summary?.info.id);
    });
  });

  describe("anchored iterative summarization (L2)", () => {
    const trace = { traceId: TEST_TRACE_ID, sessionId: "test" };
    const opts = { contextWindowTokens: 1000, protectRecentMessages: 2 };

    it("excludes user messages from the summarizer and preserves them byte-exact", async () => {
      const userText = `제약: 절대 요약하지 마라\n${"x".repeat(50)}\t🧭`;
      const seen: Message.WithParts[][] = [];
      const messages = [
        makeUserMessage(userText),
        makeAssistantMessage("a1"),
        makeUserMessage("u2"),
        makeAssistantMessage("a3"),
        makeUserMessage("u4"),
        makeAssistantMessage("a5"),
      ];
      const result = await isolated(
        Compaction.compact(
          messages,
          {
            ...opts,
            onSummarize: (input: Message.WithParts[]) =>
              Effect.sync(() => {
                seen.push(input);
                return "anchor-v1";
              }),
          },
          trace,
          Bus,
          { trigger: "threshold" },
        ),
      );

      // Summarizer saw assistants only.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.every((m: Message.WithParts) => m.info.role === "assistant")).toBe(true);
      // Every user message survives byte-exact, in order, after the anchor —
      // each preceded by its policy-injected time marker, which is a
      // separate part and never touches the user's bytes.
      const texts = textsOf(result.messages);
      expect(texts[0]).toContain("anchor-v1");
      expect(texts[1]).toMatch(/^\[recorded \d{4}-\d{2}-\d{2}\]$/);
      expect(texts[2]).toBe(userText);
      expect(texts[3]).toMatch(/^\[recorded \d{4}-\d{2}-\d{2}\]$/);
      expect(texts[4]).toBe("u2");
      // The marker is tagged, not user speech, and dates the message's own
      // recorded creation time.
      const preserved = result.messages[1];
      const marker = preserved?.parts[0];
      if (preserved === undefined || marker?.type !== "text") throw new Error("shape");
      expect(marker.metadata?.policyInjected).toBe(true);
      expect(marker.metadata?.timeCarriage).toBe(true);
      expect(marker.text).toBe(
        `[recorded ${new Date(preserved.info.time.created).toISOString().slice(0, 10)}]`,
      );
    });

    it("threads the previous anchor body through the second cut — no recursive re-summarization", async () => {
      const calls: Array<{ input: Message.WithParts[]; previous: string | undefined }> = [];
      const summarize = (input: Message.WithParts[], previous?: string) =>
        Effect.sync(() => {
          calls.push({ input, previous });
          return previous === undefined ? "anchor-v1" : `${previous}+v2`;
        });
      const first = await isolated(
        Compaction.compact(
          [
            makeUserMessage("u0"),
            makeAssistantMessage("a1"),
            makeAssistantMessage("a2"),
            makeUserMessage("u3"),
            makeAssistantMessage("a4"),
          ],
          { ...opts, onSummarize: summarize },
          trace,
          Bus,
          { trigger: "threshold" },
        ),
      );
      expect(calls[0]?.previous).toBeUndefined();
      const priorAnchor = first.messages[0];
      if (priorAnchor === undefined) throw new Error("expected prior anchor");
      priorAnchor.parts.unshift({
        id: nextId("anchor-prefix"),
        sessionID: priorAnchor.info.sessionID,
        messageID: priorAnchor.info.id,
        type: "text",
        text: "unmarked prefix",
      });

      // Grow the compacted history and cut again: the anchor render from cut
      // one sits in the new cut span.
      const grown = [
        ...first.messages,
        makeAssistantMessage("a5"),
        makeAssistantMessage("a6"),
        makeUserMessage("u7"),
        makeAssistantMessage("a8"),
      ];
      const second = await isolated(
        Compaction.compact(grown, { ...opts, onSummarize: summarize }, trace, Bus, {
          trigger: "threshold",
        }),
      );

      expect(calls).toHaveLength(2);
      // The previous anchor arrived as state, not as content:
      expect(calls[1]?.previous).toBe("anchor-v1");
      // ...and the anchor RENDER never re-entered the summarizer input.
      const secondInputTexts = calls[1] === undefined ? undefined : textsOf(calls[1].input);
      expect(secondInputTexts?.some((t: string) => t.includes("anchor-v1"))).toBe(false);
      expect(calls[1]?.input.every((m: Message.WithParts) => m.info.role === "assistant")).toBe(
        true,
      );
      // Exactly one anchor message in the result — replaced, not stacked.
      const anchors = second.messages.filter((m: Message.WithParts) =>
        m.parts.some(
          (p: Message.Part) => p.type === "text" && p.metadata?.compactionAnchor === true,
        ),
      );
      expect(anchors).toHaveLength(1);
      const anchorPart = anchors[0]?.parts[0];
      if (anchorPart?.type !== "text") throw new Error("shape");
      expect(anchorPart.metadata?.anchorBody).toBe("anchor-v1+v2");
      // The anchor carries the ordered window selection as CONTENT (role/text) —
      // ids do not survive the hydration seam — so a product-side observer can
      // persist the whole replacement record by persisting this message.
      const kept = anchorPart.metadata?.keptWindow;
      if (!Array.isArray(kept)) throw new Error("expected keptWindow");
      // Time markers are derived render — regenerated from the structured
      // `time` at every cut — so the record excludes them: recording
      // them as content would replay them as pseudo-speech after resume.
      expect(kept).toEqual(
        second.messages
          .slice(1)
          .flatMap((m: Message.WithParts) =>
            m.parts
              .filter(
                (part: Message.Part): part is Message.TextPart =>
                  part.type === "text" && part.metadata?.timeCarriage !== true,
              )
              .map((part: Message.TextPart) => ({
                role: m.info.role,
                text: part.text,
                time: m.info.time.created,
              })),
          ),
      );
    });

    it("markers are regenerated, never stacked; nudges are not dated (#737)", async () => {
      const nudge: Message.WithParts = {
        ...makeUserMessage("[policy] wrap up"),
      };
      const nudgePart = nudge.parts[0];
      if (nudgePart?.type !== "text") throw new Error("shape");
      nudge.parts = [{ ...nudgePart, metadata: { policyInjected: true } }];

      const first = await isolated(
        Compaction.compact(
          [
            makeUserMessage("u0"),
            nudge,
            makeAssistantMessage("a1"),
            makeAssistantMessage("a2"),
            makeUserMessage("u3"),
            makeAssistantMessage("a4"),
          ],
          { ...opts, onSummarize: () => Effect.sync(() => "anchor-v1") },
          trace,
          Bus,
          { trigger: "threshold" },
        ),
      );
      const markerCount = (message: Message.WithParts): number =>
        message.parts.filter(
          (p: Message.Part) => p.type === "text" && p.metadata?.timeCarriage === true,
        ).length;
      const u0 = first.messages.find((m: Message.WithParts) =>
        m.parts.some((p: Message.Part) => p.type === "text" && p.text === "u0"),
      );
      if (u0 === undefined) throw new Error("expected preserved u0");
      expect(markerCount(u0)).toBe(1);
      // A wholly-injected nudge is bookkeeping, not speech — never dated.
      const preservedNudge = first.messages.find((m: Message.WithParts) =>
        m.parts.some((p: Message.Part) => p.type === "text" && p.text === "[policy] wrap up"),
      );
      if (preservedNudge === undefined) throw new Error("expected preserved nudge");
      expect(markerCount(preservedNudge)).toBe(0);

      // Second in-run cut over already-stamped messages: the marker is
      // REPLACED (regenerated from info.time), never accumulated.
      const second = await isolated(
        Compaction.compact(
          [
            ...first.messages,
            makeAssistantMessage("a5"),
            makeAssistantMessage("a6"),
            makeUserMessage("u7"),
            makeAssistantMessage("a8"),
          ],
          { ...opts, onSummarize: () => Effect.sync(() => "anchor-v2") },
          trace,
          Bus,
          { trigger: "threshold" },
        ),
      );
      const u0Again = second.messages.find((m: Message.WithParts) =>
        m.parts.some((p: Message.Part) => p.type === "text" && p.text === "u0"),
      );
      if (u0Again === undefined) throw new Error("expected u0 in second window");
      expect(markerCount(u0Again)).toBe(1);
      // And the record never carries a marker: it is derived render.
      const anchor = second.messages[0]?.parts[0];
      if (anchor?.type !== "text") throw new Error("shape");
      const kept = parseKeptWindow(anchor.metadata?.keptWindow);
      expect(
        kept.every((entry: { time: number; text: string }) => !entry.text.startsWith("[recorded ")),
      ).toBe(true);
    });

    it("skips the model call when the cut span holds nothing summarizable", async () => {
      let called = 0;
      // First cut produces an anchor; the follow-up span contains only user
      // messages, so the anchor must carry forward without a summarize call.
      const first = await isolated(
        Compaction.compact(
          [
            makeUserMessage("u0"),
            makeAssistantMessage("a1"),
            makeUserMessage("u2"),
            makeAssistantMessage("a3"),
          ],
          {
            ...opts,
            onSummarize: () =>
              Effect.sync(() => {
                called += 1;
                return "anchor-v1";
              }),
          },
          trace,
          Bus,
          { trigger: "threshold" },
        ),
      );
      expect(called).toBe(1);
      const anchorMessage = first.messages[0];
      if (anchorMessage === undefined) throw new Error("shape");
      // Cut span = [anchor, u4, u5]: nothing summarizable, anchor must carry.
      const grown = [
        anchorMessage,
        makeUserMessage("u4"),
        makeUserMessage("u5"),
        makeUserMessage("u6"),
        makeAssistantMessage("tail"),
      ];
      const second = await isolated(
        Compaction.compact(
          grown,
          {
            ...opts,
            protectRecentMessages: 2,
            onSummarize: () =>
              Effect.sync(() => {
                called += 1;
                return "should-not-run";
              }),
          },
          trace,
          Bus,
          { trigger: "threshold" },
        ),
      );
      expect(called).toBe(1);
      const anchorPart = second.messages[0]?.parts[0];
      if (anchorPart?.type !== "text") throw new Error("shape");
      expect(anchorPart.metadata?.anchorBody).toBe("anchor-v1");
    });

    it("counts completed tool output when selecting preserved user messages", async () => {
      const newestText = "h".repeat(50);
      const newestUser = makeUserMessage(newestText);
      newestUser.parts.push({
        id: nextId("user-tool-part"),
        sessionID: "test",
        messageID: newestUser.info.id,
        type: "tool",
        callID: "user-tool-call",
        tool: "read_file",
        state: {
          status: "completed",
          input: {},
          output: "o".repeat(60),
          title: "read_file",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      });
      // The newest text alone fits the 100-char budget, but its completed
      // 60-char tool output takes the message to 110. It is retained as the
      // newest user, while accounting for the output excludes the older user.
      const result = await isolated(
        Compaction.compact(
          [
            makeUserMessage("old-user"),
            makeAssistantMessage("a1"),
            newestUser,
            makeAssistantMessage("a2"),
            makeUserMessage("tail-u"),
            makeAssistantMessage("tail-a"),
          ],
          {
            ...opts,
            preserveUserMessageChars: 100,
            onSummarize: () => Effect.sync(() => "anchor"),
          },
          trace,
          Bus,
          { trigger: "threshold" },
        ),
      );
      const texts = textsOf(result.messages);
      expect(texts).toContain(newestText);
      expect(texts).not.toContain("old-user");
    });

    it("refuses a zero-progress cut instead of reporting it as compaction (review M1)", async () => {
      let called = 0;
      // All-user span within budget: the rebuild would be [same users, tail]
      // — not one char smaller. Committing it would count as progress toward
      // the disarm while reclaiming nothing, so it must be a recorded
      // non-action, and the summarizer must not be paid for it.
      const result = await isolated(
        Compaction.compact(
          [
            makeUserMessage("u0"),
            makeUserMessage("u1"),
            makeUserMessage("u2"),
            makeUserMessage("u3"),
            makeUserMessage("tail-1"),
            makeAssistantMessage("tail-2"),
          ],
          {
            ...opts,
            onSummarize: () =>
              Effect.sync(() => {
                called += 1;
                return "never";
              }),
          },
          trace,
          Bus,
          { trigger: "threshold" },
        ),
      );
      expect(called).toBe(0);
      expect(result.compacted).toBe(false);
      expect(result.removedCount).toBe(0);
      expect(result.messages).toHaveLength(6);
    });

    it.each([
      { name: "without an anchor render", summary: "   ", anchored: false },
      {
        name: "when the anchor render heads the kept window",
        summary: "anchor body",
        anchored: true,
      },
    ] as const)("records anchored=$anchored $name", async ({
      summary,
      anchored,
    }: {
      summary: string;
      anchored: boolean;
    }) => {
      const completed = captureBusEvents(RunEvents.CompactionCompleted);
      try {
        const result = await isolated(
          Compaction.compact(
            [
              makeUserMessage("u0"),
              makeAssistantMessage("a1"),
              makeAssistantMessage("a2"),
              makeUserMessage("tail-u"),
              makeAssistantMessage("tail-a"),
            ],
            { ...opts, onSummarize: () => Effect.sync(() => summary) },
            trace,
            Bus,
            { trigger: "threshold" },
          ),
        );
        expect(result.compacted).toBe(true);
        const cut = (await completed.done).find(
          (event: (typeof completed.events)[number]) => event.outcome === "cut",
        );
        expect(completed.events).toHaveLength(1);
        expect(cut?.anchored).toBe(anchored);
      } finally {
        completed.unsubscribe();
      }
    });
  });
});

describe("CompactionRun seam", () => {
  const WINDOW = 1000;
  const identity = { traceId: "trace", sessionId: "seam", runId: "run", actorId: "actor" };

  function seamState(measured: number) {
    const messages = [
      { role: "user" as const, content: "seam-user-0", id: "seam-user-0" },
      ...Array.from({ length: 5 }, (_entry: undefined, index: number) => ({
        role: "assistant" as const,
        content: `evidence ${"filler ".repeat(40)}`,
        id: `seam-assistant-${index}`,
      })),
      { role: "user" as const, content: "seam-user-1", id: "seam-user-1" },
      { role: "assistant" as const, content: "tail", id: "seam-tail" },
    ];
    const state = createRunState(runInput(messages), testMessageSource());
    recordCallContext(state, measured);
    return state;
  }

  function run(events = collector()) {
    return new CompactionRun(
      { options: { contextWindowTokens: WINDOW, protectRecentMessages: 2 }, identity, events },
      undefined,
    );
  }

  it("prepares without writing during a tool loop, then compacts at the turn end", async () => {
    const recording = recoveryRecording();
    const rows = () => recording.committed.filter((action) => action.kind === "compaction");
    let rowsAtSecondCall = -1;
    let calls = 0;
    const result = await isolated(runTestAgent(
      runInput([
        { role: "user", content: "goal" },
        { role: "assistant", content: "old evidence ".repeat(80) },
        { role: "user", content: "recent question" },
        { role: "assistant", content: "recent answer" },
        { role: "user", content: "continue" },
      ]),
      {
        events: collector(),
        executor: recording.executor,
        model: { provider: "provider", id: "model" },
        compaction: { contextWindowTokens: WINDOW, protectRecentMessages: 2, speculate: false },
        llm: windowedLlm(async (_input, sink) => {
          calls += 1;
          if (calls === 2) rowsAtSecondCall = rows().length;
          sink.onMessage(assistantWithParts(
            `step-${calls}`,
            "seam",
            [
              { id: `text-${calls}`, sessionID: "seam", messageID: `step-${calls}`, type: "text", text: "answer" },
              {
                id: `finish-${calls}`, sessionID: "seam", messageID: `step-${calls}`,
                type: "step-finish", reason: calls === 1 ? "tool-calls" : "stop",
                tokens: { input: 900, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              },
            ],
            900,
            1,
          ));
          return { type: calls === 1 ? "continue" : "stop" };
        }),
      },
    ));
    expect(calls).toBe(2);
    expect(rowsAtSecondCall).toBe(0);
    expect(result.compactionCount).toBe(1);
    expect(rows().length).toBeGreaterThan(0);
  });

  it("skips the threshold reason below the window threshold with zero facts", async () => {
    const events = collector();
    const state = seamState(10);
    const before = state.messages;
    expect(await isolated(run(events).maybeCompact(state, "threshold"))).toBe("skipped");
    expect(events.named(RunEvents.CompactionStarted.name)).toHaveLength(0);
    expect(state.messages).toBe(before);
    expect(state.compactionCount).toBe(0);
  });

  it("never skips the overflow reason: the same below-threshold state compacts", async () => {
    const events = collector();
    const state = seamState(10);
    expect(await isolated(run(events).maybeCompact(state, "overflow"))).toBe("completed");
    expect(state.compactionCount).toBe(1);
    expect(state.lastCallContextTokens).toBeUndefined();
    expect(events.named(RunEvents.CompactionStarted.name).map((data) => RunEvents.CompactionStarted.schema.parse(data).trigger))
      .toEqual(["yield"]);
  });

  it("records a summarizer failure on the existing compaction row instead of a new fact kind", async () => {
    const recording = recoveryRecording();
    const result = await isolated(executeCompaction({
      history: seamState(900).messages,
      executor: recording.executor,
      options: {
        contextWindowTokens: WINDOW,
        protectRecentMessages: 2,
        onSummarize: () => Effect.fail(new AgentFailure({ operation: "test", cause: "summarizer unavailable" })),
      },
      identity,
      events: collector(),
      dispatch: { trigger: "threshold", measuredTokens: 900 },
    }));
    expect(result).toMatchObject({ compacted: true, summarizerFailed: true });
    const rows = recording.committed.filter((action) => action.kind === "compaction");
    expect(rows.map((action) => action.effect.value)).toMatchObject([
      { phase: "pending" },
      { phase: "boundary", result: { summarizerFailed: true, summary: "" } },
      { phase: "result", terminal: "executed", result: { summarizerFailed: true, summary: "" } },
    ]);
  });
});
