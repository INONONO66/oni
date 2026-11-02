import { describe, expect, test } from "bun:test";
import { anthropicModel as model, assistantMessage as buildAssistantMessage, fixedNow, sequentialIds, } from "../helpers/fixtures";
import type { Message } from "@oni/protocol";
import type { Sink } from "../../src/sink";
import { Processor } from "../helpers/native";
import { Bus } from "../helpers/observation";
import type { StreamEvent } from "../../src/processor/stream-events";

// Emission count depends on part boundaries, not token volume.

const DELTA = "tok ";
const REASONING_DELTAS = 400;
const TEXT_DELTAS_PER_BLOCK = 800;

function scenario(): StreamEvent[] {
  const chunks: StreamEvent[] = [{ type: "step-start" }];
  chunks.push({ type: "reasoning-start", id: "r1", providerMetadata: {} });
  for (let i = 0; i < REASONING_DELTAS; i++) {
    chunks.push({ type: "reasoning-delta", id: "r1", text: DELTA });
  }
  chunks.push({ type: "reasoning-end", id: "r1", providerMetadata: {} });
  for (let block = 0; block < 2; block++) {
    chunks.push({ type: "text-start", providerMetadata: {} });
    for (let i = 0; i < TEXT_DELTAS_PER_BLOCK; i++) {
      chunks.push({ type: "text-delta", text: DELTA });
    }
    chunks.push({ type: "text-end", providerMetadata: {} });
  }
  chunks.push({
    type: "step-finish",
    finishReason: "end_turn",
    usage: { inputTokens: 1000, outputTokens: 2000 },
    providerMetadata: {},
  });
  chunks.push({ type: "finish" });
  return chunks;
}

describe("Processor emission measurement (#545 T2)", () => {
  test("2000-delta/3-part scenario: onMessage volume", async () => {
    let onMessageCalls = 0;
    let lastMessage: Message.WithParts | undefined;
    const sink: Sink = {
      onMessage: (message) => {
        onMessageCalls += 1;
        lastMessage = message;
      },
      onToolCall: () => undefined,
      onToolResult: () => undefined,
    };

    const processor = Processor.create({
      assistantMessage: buildAssistantMessage("msg-measure", "session-measure", "parent-measure"),
      sessionID: "session-measure",
      model,
      abort: new AbortController().signal,
      now: fixedNow,
      id: sequentialIds(),
      sink,
      events: { publish: Bus.publish },
      trace: { traceId: "trace-processor-test", sessionId: "session-measure" },
      createStream: async () => ({
        fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          yield* scenario() as Array<{ type: string }>;
        })(),
      }),
    });

    await processor.process({ system: "", promptText: "" });

    // Content sanity: the boundary snapshots still deliver the full text.
    const texts = (lastMessage?.parts ?? []).flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
    expect(texts).toEqual([
      DELTA.repeat(TEXT_DELTAS_PER_BLOCK).trimEnd(),
      DELTA.repeat(TEXT_DELTAS_PER_BLOCK).trimEnd(),
    ]);
    const reasoning = (lastMessage?.parts ?? []).flatMap((part) =>
      part.type === "reasoning" ? [part.text] : [],
    );
    expect(reasoning).toEqual([DELTA.repeat(REASONING_DELTAS).trimEnd()]);

    // Boundary-only emission: 2000 deltas may not inflate the call count.
    // step-start(1) + reasoning open/close(2) + two text blocks(4) +
    // step-finish(1) + message.finished(1) = 9.
    expect(onMessageCalls).toBe(9);
  });
});
