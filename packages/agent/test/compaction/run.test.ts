import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Message } from "@openomni/protocol";
import { isolated } from "../helpers/isolated";
import { AgentFailure } from "../../src/core/ports/failure";
import { RunEvents, createRunState, recordCallContext } from "../../src/core/loop/turn";
import { CompactionRun } from "../../src/plugins/compaction/policy";
import { executeCompaction } from "../../src/plugins/compaction/execute-cut";
import { recoveryRecording } from "../helpers/effect-g3r";
import { runInput } from "../helpers/run-input";
import { testMessageSource } from "../helpers/message-source";
import { collector } from "../helpers/observation-collector";
import { runTestAgent } from "../helpers/effect-g3";
import { windowedLlm } from "../helpers/mock-llm";
import { assistantWithParts, completedToolPart, messageSequence } from "../helpers/messages";

describe("CompactionRun port", () => {
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

  it("arms window yield from the model window without compaction overrides", () => {
    const state = seamState(100);
    const configured = new CompactionRun(
      {
        options: { contextWindowTokens: 3000, reserveTokens: 1500 },
        identity,
        events: collector(),
      },
      undefined,
    );
    expect(configured.window(state)).toBeUndefined();
    state.contextWindowTokens = WINDOW;
    expect(configured.window(state)?.yieldAt).toBe(450);
  });

  it("elides a long recorded tool output using the plugin defaults", async () => {
    const { user: makeUserMessage, assistant: makeAssistantMessage } = messageSequence("test", `\n${"filler ".repeat(50)}`);
    const tool = makeAssistantMessage("a1");
    tool.parts.push(completedToolPart(tool, "file contents", "call-big", { path: "/tmp/a" }));
    const toolPart = tool.parts.find((part: Message.Part): part is Message.ToolPart => part.type === "tool");
    if (toolPart?.state.status !== "completed") throw new Error("missing tool fixture");
    toolPart.state.output = "x".repeat(4500);
    const state = seamState(5000);
    state.messages = [makeUserMessage("u0"), tool, makeAssistantMessage("a2"), makeAssistantMessage("a3")];
    const result = await isolated(new CompactionRun(
      { options: { contextWindowTokens: WINDOW, protectRecentMessages: 2 }, identity, events: collector() },
      undefined,
    ).maybeCompact(state, "threshold"));
    expect(result).toBe("completed");
    const kept = state.messages.flatMap((message) => message.parts).find(
      (part): part is Message.ToolPart => part.type === "tool",
    );
    expect(kept?.state.status).toBe("completed");
    if (kept?.state.status !== "completed") throw new Error("missing elided output");
    expect(kept.state.output).toContain("[output elided by compaction: 4500 chars; recall: call-big]");
    expect(kept.state.output.endsWith("x".repeat(500))).toBe(true);
    expect(kept.state.output).not.toContain("x".repeat(501));
  });

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
