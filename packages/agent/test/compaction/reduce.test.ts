import { Effect } from "effect";
import { AgentFailure } from "../../src/core/ports/failure";
import { isolated } from "../helpers/isolated";
import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { collector } from "../helpers/observation-collector";
import { Compaction } from "../../src/plugins/compaction/compact";
import { elideToolOutputs } from "../../src/plugins/compaction/reduce";
import { completedToolPart, messageSequence } from "../helpers/messages";
import { RunEvents } from "../../src/core/loop/turn";

const { user: userMessage, assistant } = messageSequence("reduce-session");

function toolMessage(output: string): Message.WithParts {
  const message = assistant("");
  return { info: message.info, parts: [completedToolPart(message, output)] };
}

const options = { minOutputChars: 100, keepHeadChars: 20 };

describe("elideToolOutputs", () => {
  it("elides old bulky outputs, keeps identity, and leaves the protected tail intact", () => {
    const bulky = "x".repeat(500);
    const messages = [toolMessage(bulky), userMessage("u1"), toolMessage(bulky), userMessage("u2")];

    const result = elideToolOutputs(messages, 2, options);

    const oldTool = result.messages[0]?.parts[0];
    if (oldTool?.type !== "tool" || oldTool.state.status !== "completed") throw new Error("shape");
    // The marker is a recall pointer (compaction-design L1): it carries the
    // part's callID so the elided output stays addressable in the transcript.
    const expectedMarker = `[output elided by compaction: 500 chars; recall: ${oldTool.callID}]\n${"x".repeat(20)}`;
    expect(oldTool.state.output).toBe(expectedMarker);
    // net shrink: original length minus the full replacement
    expect(result.elidedChars).toBe(500 - expectedMarker.length);
    const originalPart = messages[0]?.parts[0];
    if (originalPart === undefined) throw new Error("shape");
    expect(oldTool.id).toBe(originalPart.id);
    // the protected tail's bulky output survives untouched
    const recentTool = result.messages[2]?.parts[0];
    if (recentTool?.type !== "tool" || recentTool.state.status !== "completed")
      throw new Error("shape");
    expect(recentTool.state.output).toBe(bulky);
    // input messages are not mutated
    const original = messages[0]?.parts[0];
    if (original?.type !== "tool" || original.state.status !== "completed")
      throw new Error("shape");
    expect(original.state.output).toBe(bulky);
  });

  it("is idempotent: a second pass over its own output finds nothing", () => {
    const messages = [toolMessage("x".repeat(500)), userMessage("u1"), userMessage("u2")];
    const once = elideToolOutputs(messages, 1, options);
    const twice = elideToolOutputs(once.messages, 1, options);

    const elided = once.messages[0]?.parts[0];
    if (elided?.type !== "tool" || elided.state.status !== "completed") throw new Error("shape");
    expect(once.elidedChars).toBe(500 - elided.state.output.length);
    expect(twice.elidedChars).toBe(0);
    expect(twice.messages).toEqual(once.messages);
  });

  it("reclaims nothing from small outputs or non-completed tools", () => {
    const messages = [toolMessage("small"), userMessage("u1"), userMessage("u2")];
    expect(elideToolOutputs(messages, 1, options).elidedChars).toBe(0);
  });
});

describe("Compaction.compact with elision configured", () => {
  const trace = { traceId: "trace-reduce", sessionId: "session-reduce" };

  /** One threshold round over a 4-message history whose only tool output is `output`. */
  async function compactElided(output: string, measuredTokens?: number) {
    const sink = collector();
    const messages = [userMessage("u0"), toolMessage(output), userMessage("u1"), userMessage("u2")];
    const result = await isolated(
      Compaction.compact(
        messages,
        { contextWindowTokens: 100, protectRecentMessages: 2, elideToolOutputs: options },
        trace,
        sink,
        measuredTokens === undefined
          ? { trigger: "threshold" }
          : { trigger: "threshold", measuredTokens },
      ),
    );
    return { sink, messages, result };
  }

  it("reduces instead of cutting while there is something to elide", async () => {
    const { sink, result } = await compactElided("x".repeat(500));

    expect(result.compacted).toBe(true);
    expect(result.removedCount).toBe(0);
    expect(result.messages).toHaveLength(4);
    expect(sink.events.map((event: (typeof sink.events)[number]) => event.name)).toEqual([
      RunEvents.CompactionStarted.name,
      RunEvents.CompactionCompleted.name,
    ]);
    expect(RunEvents.CompactionCompleted.schema.parse(sink.events[1]?.data)).toMatchObject({
      ...trace,
      outcome: "reduced",
      messagesBefore: 4,
      messagesAfter: 4,
      removedCount: 0,
    });
  });

  it("falls back to the cut once elision has nothing left", async () => {
    const { result } = await compactElided("small");

    expect(result.compacted).toBe(true);
    expect(result.removedCount).toBeGreaterThan(0);
  });

  it("never grows an output: the unsafe-config region is skipped, not stacked", () => {
    // Adversarial review, executably: with keepHead 80 the replacement of a
    // 110-char output would be ~124 chars — the old code committed that as
    // positive yield and stacked markers forever. Strictly-shorter is the
    // structural termination guarantee for every config, including
    // minOutputChars: 1.
    const unsafe = { minOutputChars: 100, keepHeadChars: 80 };
    const messages = [toolMessage("x".repeat(110)), userMessage("u1"), userMessage("u2")];

    const result = elideToolOutputs(messages, 1, unsafe);

    expect(result.elidedChars).toBe(0);
    const part = result.messages[0]?.parts[0];
    if (part?.type !== "tool" || part.state.status !== "completed") throw new Error("shape");
    expect(part.state.output).toBe("x".repeat(110));

    const large = elideToolOutputs(
      [toolMessage("x".repeat(500)), userMessage("u1"), userMessage("u2")],
      1,
      unsafe,
    );
    const second = elideToolOutputs(large.messages, 1, unsafe);
    expect(large.elidedChars).toBeGreaterThan(0);
    expect(second.elidedChars).toBe(0);
    expect(second.messages).toEqual(large.messages);
  });

  it("also cuts in the same round when elision cannot cover the measured overage", async () => {
    // The cut-starvation fix: under sustained tool use
    // elision always finds a fresh aged-out output, so "cut when nothing is
    // left to elide" never fires. When the estimated net reclaim (chars/4)
    // falls short of the measured overage, the cut runs on the already-elided
    // history in the same round.
    // measured: overage ~9920 tokens; elision nets 439 chars ≈ 110 tokens
    const { messages, result } = await compactElided("x".repeat(500), 10_000);

    expect(result.compacted).toBe(true);
    expect(result.removedCount).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("keeps successful elision when the subsequent summarizer fails", async () => {
    const sink = collector();
    const messages = [
      toolMessage("x".repeat(500)),
      toolMessage("small-old"),
      toolMessage("tail-1"),
      toolMessage("tail-2"),
    ];

    const result = await isolated(
      Compaction.compact(
        messages,
        {
          contextWindowTokens: 100,
          protectRecentMessages: 2,
          elideToolOutputs: options,
          onSummarize: () =>
            Effect.fail(new AgentFailure({ operation: "test", cause: "summary unavailable" })),
        },
        trace,
        sink,
        { trigger: "threshold", measuredTokens: 10_000 },
      ),
    );

    expect(result.compacted).toBe(true);
    expect(result.removedCount).toBe(0);
    expect(result.summarizerFailed).toBe(true);
    const elided = result.messages[0]?.parts[0];
    if (elided?.type !== "tool" || elided.state.status !== "completed") {
      throw new Error("expected an elided tool result");
    }
    expect(elided.state.output.length).toBeLessThan(500);
  });

  it("keeps the round to elision alone when the estimated reclaim covers the overage", async () => {
    // measured: overage 20 tokens; elision nets 439 chars ≈ 110 tokens
    const { result } = await compactElided("x".repeat(500), 100);

    expect(result.compacted).toBe(true);
    expect(result.removedCount).toBe(0);
    expect(result.messages).toHaveLength(4);
  });
});
