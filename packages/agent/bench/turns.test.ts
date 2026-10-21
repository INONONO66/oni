import { sessionTree } from "../test/helpers/session-tree";
import { describe, expect, test } from "bun:test";
import { SessionTurn } from "@oni/protocol";
import { z } from "zod";
import { bounded } from "../test/helpers/bounded";
import { firstDelta, roundTrip, tokenAccounting, toolDispatch } from "./turns";

const resultSchema = z.array(z.object({
  name: z.string(),
  unit: z.literal("ns/op"),
  value: z.number().positive(),
}).strict());

describe("turn benchmarks", () => {
  test("first delta reports sink latency rather than the drained turn duration", async () => {
    let tick = 0;
    const result = await bounded(firstDelta(() => (tick += 7)), "first assistant snapshot");
    expect(result).toEqual({ overriddenDuration: 7 });
    expect(tick).toBe(14);
  });

  test("echo dispatch commits a real tool intent and successful result", async () => {
    const dispatch = toolDispatch();
    const result = await bounded(dispatch.run(), "echo result");
    expect(result).toMatchObject({ content: "hello", toolCallId: "call-1" });
    expect(result.isError).not.toBe(true);
    const actions = dispatch.committed.filter((action) => action.kind === "tool");
    expect(actions).toHaveLength(2);
    expect(actions[0]?.intent?.value).toMatchObject({ op: "echo", phase: "intent" });
    expect(actions[1]?.intent?.value).toMatchObject({ op: "echo", phase: "result" });
    expect(actions[1]?.effect?.value).toMatchObject({ phase: "result", terminal: "executed" });
  });

  test("round trip returns only after assistant and terminal turn are committed in SQLite", async () => {
    const turn = await roundTrip();
    try {
      expect(await bounded(turn.run(), "durable turn")).toMatchObject({
        kind: "result", finishReason: "stop",
      });
      const snapshot = turn.handle.get();
      expect(snapshot.state).toBe("idle");
      expect(snapshot.turns).toHaveLength(1);
      expect(snapshot.turns[0]?.messages.map((message) => message.role)).toEqual([
        "user", "assistant",
      ]);
      const actions = sessionTree(turn.kernel, turn.handle.id);
      expect(actions.filter((action) => action.kind === "message")).toHaveLength(2);
      const terminals = actions.filter((action) =>
        action.kind === "turn" && SessionTurn.Terminal.safeParse(action.effect.value).success,
      );
      expect(terminals).toHaveLength(1);
      expect(SessionTurn.Terminal.parse(terminals[0]?.effect.value).kind).toBe("result");
    } finally {
      await turn.close();
    }
  });

  test("token accounting folds one message without accumulating across samples", () => {
    const expected = {
      inputTokens: 512, outputTokens: 128, totalTokens: 640,
      reasoningTokens: 32, cacheReadTokens: 64, cacheWriteTokens: 16,
    };
    expect(tokenAccounting()).toEqual(expected);
    expect(tokenAccounting()).toEqual(expected);
  });

  test("benchmark entry point writes exactly four compaction and four turn metrics", async () => {
    await import(".");
    const results = resultSchema.parse(await Bun.file("bench-results/agent.json").json());
    expect(results.map((result) => result.name)).toEqual([
      "compaction/20-messages",
      "compaction/100-messages",
      "compaction/500-messages",
      "compaction/should-compact",
      "turn/first-delta",
      "turn/tool-dispatch",
      "turn/round-trip",
      "turn/token-accounting",
    ]);
  });
});
