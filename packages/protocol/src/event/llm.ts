import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { Token } from "../token/index.js";
import { EpochMs } from "../time.js";

const Base = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  runId: z.string().optional(),
  time: EpochMs,
});

export namespace LlmCall {
  export namespace Events {
    export const Started = BusEvent.define(
      "llm.call.started",
      Base.extend({
        provider: z.string(),
        model: z.string(),
        messageCount: z.number(),
        toolCount: z.number(),
      }),
      { visibility: "ephemeral" },
    );

    export const Completed = BusEvent.define(
      "llm.call.completed",
      Base.extend({
        provider: z.string(),
        model: z.string(),
        durationMs: z.number(),
        inputTokens: Token.Count,
        outputTokens: Token.Count,
        reasoningTokens: Token.Count,
        cacheReadTokens: Token.Count,
        cacheWriteTokens: Token.Count,
        finishReason: z.string(),
      }),
      { visibility: "llm_reason" },
    );

    export const Failed = BusEvent.define(
      "llm.call.failed",
      Base.extend({
        provider: z.string(),
        model: z.string(),
        durationMs: z.number(),
        error: z.string(),
        aborted: z.boolean(),
      }),
      { visibility: "llm_reason" },
    );

    /**
     * One settled speech-to-text provider call. Media derivation runs
     * before any session binds the attachment, so the row carries the
     * caller's trace id and no session or run identity.
     */
    export const TranscriptionCompleted = BusEvent.define(
      "llm.transcription.completed",
      z.object({
        traceId: z.string(),
        time: EpochMs,
        provider: z.string(),
        model: z.string(),
        inputBytes: z.number().int().nonnegative(),
        durationMs: z.number(),
      }),
      { visibility: "llm_reason" },
    );

    export const RetryDecided = BusEvent.define(
      "llm.call.retry.decided",
      Base.extend({
        attempt: z.number(),
        maxAttempts: z.number(),
        reason: z.string(),
        backoffMs: z.number(),
      }),
      { visibility: "llm_reason" },
    );

    export const RateLimited = BusEvent.define(
      "llm.rate.limited",
      Base.extend({
        provider: z.string(),
        retryAfterMs: z.number(),
      }),
      { visibility: "llm_reason" },
    );
  }
}
