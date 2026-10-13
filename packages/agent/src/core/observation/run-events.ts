import { z } from "zod";
import { BusEvent, Token } from "@openomni/protocol";
import { RetryReason } from "../ports/reason-codes";

const AgentBase = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  /** Optional only so rows recorded before the field existed still parse (upcast-on-read). */
  actorId: z.string().optional(),
  time: z.number(),
});

/** Persisted names stay the historical `agent.*` strings: ledger rows key on them byte-for-byte. */
export const RunEvents = {
  TurnStart: BusEvent.define(
    "agent.turn.start",
    AgentBase.extend({
      turnIndex: z.number(),
    }),
    { visibility: "ephemeral" },
  ),
  TurnComplete: BusEvent.define(
    "agent.turn.complete",
    AgentBase.extend({
      turnIndex: z.number(),
      usage: Token.AgentUsage,
    }),
    { visibility: "llm_reason" },
  ),
  /**
   * `completed` is the last record on every exit path (a summarizer throw included), so a started
   * row without one diagnoses a run that died inside compaction.
   */
  CompactionStarted: BusEvent.define(
    "agent.compaction.started",
    AgentBase.extend({
      messagesBefore: z.number(),
      contextTokens: z.number().optional(),
      trigger: z.enum(["threshold", "yield"]),
      summarizer: z.boolean(),
    }),
    { visibility: "internal" },
  ),
  CompactionCompleted: BusEvent.define(
    "agent.compaction.completed",
    AgentBase.extend({
      outcome: z.enum(["cut", "reduced", "nothing_reclaimed", "no_user_boundary", "failed"]),
      messagesBefore: z.number(),
      messagesAfter: z.number(),
      removedCount: z.number(),
      elidedChars: z.number(),
      /**
       * An unanchored cut is a different loss class than an anchored one and must not masquerade as
       * it; absent on rows recorded before the field existed.
       */
      anchored: z.boolean().optional(),
      savedTokens: z.number().optional(),
      tokensBefore: z.number().optional(),
      ineffective: z.boolean().optional(),
      error: z.string().optional(),
    }),
    { visibility: "internal" },
  ),
  ErrorRetry: BusEvent.define(
    "agent.error.retry",
    AgentBase.extend({
      attempt: z.number(),
      maxAttempts: z.number(),
      error: z.string(),
      reason: RetryReason,
      backoffMs: z.number(),
    }),
    { visibility: "llm_reason" },
  ),
};
