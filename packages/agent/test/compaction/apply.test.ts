import { Effect } from "effect";
import { AgentFailure } from "../../src/core/ports/failure";
import { isolated } from "../helpers/isolated";
import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Compaction } from "../../src/plugins/compaction";
import { collector } from "../helpers/observation-collector";
import { resolveCompactionGeometry } from "../../src/plugins/compaction/geometry";
import { textMessage } from "../helpers/messages";

function user(id: string): Message.WithParts {
  return textMessage("user", id, identity.sessionId, id);
}

function assistant(id: string): Message.WithParts {
  return textMessage("assistant", id, identity.sessionId, id);
}

const identity = { traceId: "trace", sessionId: "policy-session", runId: "run" };

describe("compaction geometry and application", () => {
  it("uses adaptive geometry instead of cumulative run spend", () => {
    expect(Compaction.shouldCompact(449, { contextWindowTokens: 1000 })).toBe(false);
    expect(Compaction.shouldCompact(450, { contextWindowTokens: 1000 })).toBe(true);
  });

  it("reserves configured headroom before the ratio threshold", () => {
    expect(
      resolveCompactionGeometry({ contextWindowTokens: 1000, reserveTokens: 600 }).thresholdTokens,
    ).toBe(400);
  });

  it("moves a low-yield next threshold later", () => {
    expect(
      resolveCompactionGeometry({
        contextWindowTokens: 1000,
        previousYield: { savedTokens: 20, tokensBefore: 500 },
      }).thresholdTokens,
    ).toBe(500);
  });

  it("cuts at a user boundary when the threshold seam fires", async () => {
    const messages = Array.from({ length: 8 }, (_entry: undefined, index: number) =>
      user(`u${index}`),
    );
    const result = await isolated(
      Compaction.compact(
        messages,
        { contextWindowTokens: 1000, protectRecentMessages: 2 },
        identity,
        collector(),
        { trigger: "threshold", measuredTokens: 900 },
      ),
    );
    expect(result.compacted).toBe(true);
    expect(result.messages).toHaveLength(2);
  });

  it("falls back to a user-boundary cut when summarization fails", async () => {
    const messages = [
      user("fallback-user-0"),
      ...Array.from({ length: 5 }, (_entry: undefined, index: number) =>
        assistant(`fallback-assistant-${index}`),
      ),
      user("fallback-user-1"),
      assistant("fallback-tail"),
    ];
    const result = await isolated(
      Compaction.compact(
        messages,
        {
          contextWindowTokens: 1000,
          protectRecentMessages: 2,
          onSummarize: () =>
            Effect.fail(new AgentFailure({ operation: "test", cause: "summarizer unavailable" })),
        },
        identity,
        collector(),
        { trigger: "threshold", measuredTokens: 900 },
      ),
    );
    expect(result).toMatchObject({ compacted: true, summarizerFailed: true });
    expect(result.messages).toHaveLength(2);
  });

  it("records nothing reclaimed when the protected tail covers history", async () => {
    const messages = [user("u0")];
    const result = await isolated(
      Compaction.compact(
        messages,
        { contextWindowTokens: 1000, protectRecentMessages: 2 },
        identity,
        collector(),
        { trigger: "yield", measuredTokens: 900 },
      ),
    );
    expect(result).toMatchObject({ compacted: false, removedCount: 0 });
  });
});
