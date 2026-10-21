import { Effect } from "effect";
import type { ExecutionError, Entropy } from "../../core/api";
import type { Message } from "@oni/protocol";
import type {
  ResolvedCompactionOptions,
  FinishCompaction,
  ReducedHistory,
  CompactionResult,
  AnchoredCutAttempt,
} from "./contract";
import { DEFAULT_PROTECT_RECENT, DEFAULT_PRESERVE_USER_CHARS } from "./contract";
import { elideToolOutputs } from "./reduce";
import { resolveThresholdTokens, ESTIMATED_CHARS_PER_TOKEN } from "./estimate";
import { isAnchorMessage, isWarmCandidateValid } from "./candidate";
import { attemptAnchoredCut } from "./summary";
import type { CompactionCandidate } from "./speculate";

function reduceHistoryBeforeCut(
  messages: Message.WithParts[],
  options: ResolvedCompactionOptions,
  protectRecent: number,
  measuredContextTokens: number | undefined,
  finish: FinishCompaction,
): ReducedHistory {
  if (options.elideToolOutputs === undefined) return { working: messages, elidedChars: 0 };

  const reduction = elideToolOutputs(messages, protectRecent, options.elideToolOutputs);
  if (reduction.elidedChars === 0) return { working: messages, elidedChars: 0 };

  const overageTokens =
    measuredContextTokens === undefined
      ? undefined
      : measuredContextTokens - resolveThresholdTokens(options);
  const estimatedReclaimTokens = reduction.elidedChars / ESTIMATED_CHARS_PER_TOKEN;
  if (overageTokens !== undefined && estimatedReclaimTokens < overageTokens) {
    return { working: reduction.messages, elidedChars: reduction.elidedChars };
  }
  return {
    working: reduction.messages,
    elidedChars: reduction.elidedChars,
    completed: finish(
      { messages: reduction.messages, compacted: true, removedCount: 0 },
      "reduced",
      reduction.elidedChars,
    ),
  };
}

function finishUnavailableCut(
  cutoff: number | undefined,
  working: Message.WithParts[],
  elidedChars: number,
  finish: FinishCompaction,
): CompactionResult | undefined {
  if (cutoff === undefined) {
    return elidedChars > 0
      ? finish({ messages: working, compacted: true, removedCount: 0 }, "reduced", elidedChars)
      : finish(
          { messages: working, compacted: false, removedCount: 0, blocked: "no_user_boundary" },
          "no_user_boundary",
          0,
        );
  }
  if (cutoff !== 0) return undefined;
  return elidedChars > 0
    ? finish({ messages: working, compacted: true, removedCount: 0 }, "reduced", elidedChars)
    : finish({ messages: working, compacted: false, removedCount: 0 }, "nothing_reclaimed", 0);
}

function finishAnchoredCut(
  attempt: AnchoredCutAttempt,
  candidateOutcome: "promoted" | "discarded" | undefined,
  messages: Message.WithParts[],
  working: Message.WithParts[],
  elidedChars: number,
  finish: FinishCompaction,
): CompactionResult {
  const withOutcome = (result: CompactionResult): CompactionResult =>
    candidateOutcome === undefined ? result : { ...result, candidate: candidateOutcome };
  const withFailure = (result: CompactionResult): CompactionResult =>
    attempt.summarizerError === undefined ? result : { ...result, summarizerFailed: true };

  if (attempt.cut === undefined) {
    return elidedChars > 0
      ? finish(
          withOutcome(withFailure({ messages: working, compacted: true, removedCount: 0 })),
          "reduced",
          elidedChars,
          undefined,
          attempt.summarizerError,
        )
      : finish(
          withOutcome(withFailure({ messages, compacted: false, removedCount: 0 })),
          "nothing_reclaimed",
          0,
          undefined,
          attempt.summarizerError,
        );
  }

  return finish(
    withOutcome(withFailure(attempt.cut)),
    "cut",
    elidedChars,
    attempt.cut.messages[0] !== undefined && isAnchorMessage(attempt.cut.messages[0]),
    attempt.summarizerError,
  );
}

function chooseAnchoredCut(
  working: Message.WithParts[],
  original: Message.WithParts[],
  cutoff: number,
  firstRemoved: Message.WithParts,
  options: ResolvedCompactionOptions & {
    onSummarize: NonNullable<ResolvedCompactionOptions["onSummarize"]>;
  },
  candidate: CompactionCandidate | undefined,
) {
  return Effect.gen(function* () {
  const preserveBudget = options.preserveUserMessageChars ?? DEFAULT_PRESERVE_USER_CHARS;
  const attempt = (boundary: number, anchor: string | undefined) =>
    attemptAnchoredCut(
      working.slice(0, boundary),
      original.slice(0, boundary),
      working.slice(boundary),
      anchor,
      working,
      firstRemoved,
      preserveBudget,
      options.contextWindowTokens,
      options.onSummarize,
    );
  if (candidate !== undefined && isWarmCandidateValid(candidate, working)) {
    const promoted = yield* attempt(candidate.prefixIds.length, candidate.anchorBody);
    if (promoted.cut !== undefined)
      return { attempt: promoted, candidateOutcome: "promoted" as const };
  }
  return {
    attempt: yield* attempt(cutoff, undefined),
    candidateOutcome: candidate === undefined ? undefined : ("discarded" as const),
  };
  });
}

export function compactUnbracketed(
  messages: Message.WithParts[],
  options: ResolvedCompactionOptions,
  measuredContextTokens: number | undefined,
  candidate: CompactionCandidate | undefined,
  finish: (
    result: CompactionResult,
    outcome: "cut" | "reduced" | "nothing_reclaimed" | "no_user_boundary",
    elidedChars: number,
    anchored?: boolean,
    summarizerError?: Error,
  ) => CompactionResult,
): Effect.Effect<CompactionResult, ExecutionError, Entropy> {
  return Effect.gen(function* () {
  // A reversible cut names original content as its kept boundary. Even a
  // zero-tail strategy must retain one atomic call/result entry unchanged.
  const protectRecent = Math.max(1, options.protectRecentMessages ?? DEFAULT_PROTECT_RECENT);

  if (messages.length <= protectRecent) {
    return finish({ messages, compacted: false, removedCount: 0 }, "nothing_reclaimed", 0);
  }

  // Elision postpones a cut only when its estimated reclaim covers the measured overage.
  const reduction = reduceHistoryBeforeCut(
    messages,
    options,
    protectRecent,
    measuredContextTokens,
    finish,
  );
  if (reduction.completed !== undefined) return reduction.completed;
  const { working, elidedChars } = reduction;

  // Without a summary anchor, the kept window must start at a user boundary.
  const naturalCutoff = working.length - protectRecent;
  const cutoff =
    options.onSummarize === undefined ? snapToUserBoundary(working, naturalCutoff) : naturalCutoff;
  const unavailable = finishUnavailableCut(cutoff, working, elidedChars, finish);
  if (unavailable !== undefined) return unavailable;

  const toRemove = working.slice(0, cutoff);
  const toKeep = working.slice(cutoff);

  const firstRemoved = toRemove[0];
  if (options.onSummarize !== undefined && firstRemoved !== undefined) {
    const { attempt, candidateOutcome } = yield* chooseAnchoredCut(
      working,
      messages,
      toRemove.length,
      firstRemoved,
      { ...options, onSummarize: options.onSummarize },
      candidate,
    );
    return (
      finishFallbackCut(attempt, candidateOutcome, working, naturalCutoff, elidedChars, finish) ??
      finishAnchoredCut(attempt, candidateOutcome, messages, working, elidedChars, finish)
    );
  }

  const compacted = [...toKeep];

  return finish(
    {
      messages: compacted,
      compacted: true,
      removedCount: toRemove.length,
    },
    "cut",
    elidedChars,
    false,
  );
  });
}

// A failed summarizer falls back to a plain user-boundary cut when one exists.
function finishFallbackCut(
  attempt: AnchoredCutAttempt,
  candidateOutcome: "promoted" | "discarded" | undefined,
  working: Message.WithParts[],
  naturalCutoff: number,
  elidedChars: number,
  finish: FinishCompaction,
): CompactionResult | undefined {
  if (attempt.summarizerError === undefined) return undefined;
  const fallbackCutoff = snapToUserBoundary(working, naturalCutoff);
  if (fallbackCutoff === undefined || fallbackCutoff <= 0) return undefined;
  return finish(
    {
      messages: working.slice(fallbackCutoff),
      compacted: true,
      removedCount: fallbackCutoff,
      summarizerFailed: true,
      ...(candidateOutcome === undefined ? {} : { candidate: candidateOutcome }),
    },
    "cut",
    elidedChars,
    false,
    attempt.summarizerError,
  );
}

function snapToUserBoundary(
  messages: Message.WithParts[],
  naturalCutoff: number,
): number | undefined {
  for (let index = naturalCutoff; index >= 0; index -= 1) {
    if (messages[index]?.info.role === "user") return index;
  }
  return undefined;
}
