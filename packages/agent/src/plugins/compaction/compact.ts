import { Clock, Effect } from "effect";
import { type ExecutionError, RunEvents, type Entropy, pretty } from "../../core/api";
import type { Message, BusEvent } from "@openomni/protocol";
import type { CompactionYield } from "./geometry";
import type { CompactionCandidate } from "./speculate";
import type { ResolvedCompactionOptions, CompactionResult } from "./contract";
import {
  resolveThresholdTokens,
  estimateMessagesTokens,
  isIneffectiveCompaction,
} from "./estimate";
import { withSummarizerDeadline } from "./summary";
import { compactUnbracketed } from "./cut";
import { createCompactionPlan } from "./durable";
export type { CompactionOptions } from "./contract";
export namespace Compaction {
  export function shouldCompact(
    totalTokens: number,
    options: ResolvedCompactionOptions,
    previousYield?: CompactionYield,
  ): boolean {
    return totalTokens >= resolveThresholdTokens(options, previousYield);
  }
  /**
     * `identity` is a required parameter rather than an optional field on
     * `options` because an optional field validated by a runtime throw is how
     * the caller that supplied none reached production. Exactly one `started`
     * before any work and one `completed` as the last record on every exit.
     */
  export function compact(
    messages: Message.WithParts[],
    options: ResolvedCompactionOptions,
    identity: {
      readonly traceId: string;
      readonly sessionId: string;
      readonly runId?: string;
      readonly actorId?: string;
    },
    events: BusEvent.Sink,
    dispatch: {
      readonly trigger: "threshold" | "yield";
      readonly signal?: AbortSignal;
      readonly measuredTokens?: number;
      /** Promoted with zero model calls when its canonical prefix is unchanged; else merged. */
      readonly candidate?: CompactionCandidate;
    },
  ): Effect.Effect<CompactionResult, ExecutionError, Entropy> {
    return Clock.clockWith(Effect.succeed).pipe(Effect.flatMap((clock) => Effect.suspend(() => {
    const now = (): number => clock.currentTimeMillisUnsafe();
    const messagesBefore = messages.length;
    events.publish(RunEvents.CompactionStarted, {
      ...identity,
      time: now(),
      messagesBefore,
      ...(dispatch.measuredTokens === undefined ? {} : { contextTokens: dispatch.measuredTokens }),
      trigger: dispatch.trigger,
      summarizer: options.onSummarize !== undefined,
    });

    const finish = (
      result: CompactionResult,
      outcome: "cut" | "reduced" | "nothing_reclaimed" | "no_user_boundary",
      elidedChars: number,
      anchored?: boolean,
      summarizerError?: Error,
    ): CompactionResult => {
      const estimatedTokensBefore = estimateMessagesTokens(messages);
      const tokensBefore = dispatch.measuredTokens ?? estimatedTokensBefore;
      const savedTokens = Math.max(
        0,
        estimatedTokensBefore - estimateMessagesTokens(result.messages),
      );
      const ineffective = result.compacted && isIneffectiveCompaction(savedTokens, tokensBefore);
      const completed = result.compacted
        ? {
            ...result,
            record: createCompactionPlan(messages, result.messages, tokensBefore).record,
            yield: { savedTokens, tokensBefore },
            ineffective,
          }
        : result;
      events.publish(RunEvents.CompactionCompleted, {
        ...identity,
        time: now(),
        outcome,
        messagesBefore,
        messagesAfter: result.messages.length,
        removedCount: result.removedCount,
        elidedChars,
        ...(result.compacted ? { savedTokens, tokensBefore, ineffective } : {}),
        ...(anchored === undefined ? {} : { anchored }),
        ...(summarizerError === undefined ? {} : { error: summarizerError.message }),
      });
      return completed;
    };

    const boundedOptions =
        options.onSummarize === undefined
          ? options
          : {
              ...options,
              onSummarize: withSummarizerDeadline(
                options.onSummarize,
                options.summarizerDeadlineMs,
                dispatch.signal,
              ),
            };
      return compactUnbracketed(
        messages,
        boundedOptions,
        dispatch.measuredTokens,
        dispatch.candidate,
        finish,
      ).pipe(Effect.onError((cause) => Effect.sync(() => {
      const message = pretty(cause);
      // The summarizer threw: the bracket still closes with `failed` and the throw
      // propagates unchanged into the port's fail-closed contract.
      events.publish(RunEvents.CompactionCompleted, {
        ...identity,
        time: now(),
        outcome: "failed",
        messagesBefore,
        messagesAfter: messagesBefore,
        removedCount: 0,
        elidedChars: 0,
        error: message,
      });
      })));
    })));
  }
}
