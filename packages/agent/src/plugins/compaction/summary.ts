import { Clock, Effect, Result } from "effect";
import { AgentFailure, type ExecutionError, Entropy } from "../../core/api";
import type { Message } from "@openomni/protocol";
import type { CompactionOptions, AnchoredCutAttempt } from "./contract";
import { latestAnchorBody, isAnchorMessage } from "./candidate";
import { prepareSummarizerInput, estimateContentChars, messageContentChars } from "./estimate";

const DEFAULT_SUMMARIZER_DEADLINE_MS = 60_000;

const ANCHOR_HEADER = "[Conversation Summary]\n";

/**
 * The one closed grammar a marker may wear: the L7 byte guard exempts marker parts BECAUSE a
 * 21-char `[recorded date]` line cannot smuggle paraphrased user speech.
 */
const TIME_MARKER_RE = /^\[recorded \d{4}-\d{2}-\d{2}\]$/;

/**
 * Production models must be told what markers mean, like the bench responder is. Render-only, never
 * in `anchorBody`; the literal "YYYY-MM-DD" cannot match the marker grammar, so the guard never
 * mistakes it for one.
 */
const MARKER_LEGEND =
  "(Messages marked [recorded YYYY-MM-DD] carry the date each message was recorded, in UTC.)";

export function withSummarizerDeadline(
  summarize: NonNullable<CompactionOptions["onSummarize"]>,
  deadlineMs = DEFAULT_SUMMARIZER_DEADLINE_MS,
  signal?: AbortSignal,
): NonNullable<CompactionOptions["onSummarize"]> {
  return (messages, previousAnchor, budget, operationSignal = signal) => Effect.gen(function* () {
    if (operationSignal?.aborted) return yield* Effect.interrupt;
    return yield* summarize(messages, previousAnchor, budget, operationSignal).pipe(
      Effect.timeoutOrElse({ duration: deadlineMs, orElse: () => Effect.fail(new AgentFailure({
        operation: "compaction.summarize", cause: `summarizer_deadline:${deadlineMs}`,
      }))}),
    );
  });
}

/** Shared with the L7 byte guard: tags around free text are NOT a marker; it is user speech. */
function isTimeCarriageMarkerPart(part: Message.Part): boolean {
  return (
    part.type === "text" &&
    part.metadata?.timeCarriage === true &&
    part.metadata?.policyInjected === true &&
    TIME_MARKER_RE.test(part.text)
  );
}

/** UTC calendar date by design: a host-local render would re-date the same record per machine. */
function renderTimeMarker(createdMs: number): string {
  return `[recorded ${new Date(createdMs).toISOString().slice(0, 10)}]`;
}

/** The message actually carries user speech worth dating. */
function carriesUserSpeech(message: Message.WithParts): boolean {
  return message.parts.some(
    (part) =>
      part.type === "text" &&
      part.metadata?.policyInjected !== true &&
      part.metadata?.compactionAnchor !== true,
  );
}

/**
 * Preserved user text says "yesterday" and nothing in the window says when that was. The marker is
 * REGENERATED from `info.time.created` at every cut (never accumulated) and never enters the
 * record: resume re-derives it from the structured `time`.
 */
function stampTimeMarker(message: Message.WithParts, id: () => string): Message.WithParts {
  const marker: Message.TextPart = {
    id: id(),
    sessionID: message.info.sessionID,
    messageID: message.info.id,
    type: "text",
    text: renderTimeMarker(message.info.time.created),
    metadata: { policyInjected: true, timeCarriage: true },
  };
  return {
    info: message.info,
    parts: [marker, ...message.parts.filter((part) => !isTimeCarriageMarkerPart(part))],
  };
}

function replacementRecord(
  stampedUsers: readonly Message.WithParts[],
  keepSpan: readonly Message.WithParts[],
): Array<{
  role: "user" | "assistant";
  text: string;
  time: number;
  policyInjected?: true;
}> {
  return [...stampedUsers, ...keepSpan].flatMap((message) =>
    message.parts
      .filter(
        (part: Message.Part): part is Message.TextPart =>
          part.type === "text" && !isTimeCarriageMarkerPart(part),
      )
      .map((part) => ({
        role: message.info.role,
        text: part.text,
        time: message.info.time.created,
        ...(part.metadata?.policyInjected === true ? { policyInjected: true as const } : {}),
      })),
  );
}

export function attemptAnchoredCut(
  cutSpan: Message.WithParts[],
  summaryPrefix: Message.WithParts[],
  keepSpan: Message.WithParts[],
  precomputed: string | undefined,
  working: Message.WithParts[],
  firstRemoved: Message.WithParts,
  preserveBudget: number,
  contextWindowTokens: number,
  onSummarize: NonNullable<CompactionOptions["onSummarize"]>,
): Effect.Effect<AnchoredCutAttempt, ExecutionError, Entropy> {
  return Effect.gen(function* () {
  const { id } = yield* Entropy;
  const anchorTime = yield* Clock.currentTimeMillis;
  const previousAnchor = latestAnchorBody(cutSpan);
  const hasSummarizableContent = cutSpan.some(
    (message) => message.info.role !== "user" && !isAnchorMessage(message),
  );
  const { messages: summarizerInput, budget } = prepareSummarizerInput(
    summaryPrefix,
    contextWindowTokens,
    previousAnchor,
  );
  let anchorText = precomputed ?? previousAnchor;
  let summarizerError: Error | undefined;
  if (precomputed === undefined && hasSummarizableContent && summarizerInput.length > 0) {
    const merged = yield* Effect.result(onSummarize(summarizerInput, previousAnchor, budget));
    if (Result.isSuccess(merged)) {
      anchorText = merged.success.trim().length > 0 ? merged.success : previousAnchor;
    } else {
      if (merged.failure._tag === "Interrupted") return yield* merged.failure;
      summarizerError = merged.failure;
      anchorText = previousAnchor;
    }
  }

  const preservedUsers = selectPreservedUsers(cutSpan, preserveBudget);
  if (anchorText === undefined && preservedUsers.length === 0) return { summarizerError };
  const stampedUsers = preservedUsers.map((message) =>
    carriesUserSpeech(message) ? stampTimeMarker(message, id) : message,
  );
  const keptWindow = replacementRecord(stampedUsers, keepSpan);
  const stampedAny = stampedUsers.some((message) => message.parts.some(isTimeCarriageMarkerPart));
  const anchorMessages =
    anchorText === undefined
      ? []
      : [
          buildAnchorMessage(
            anchorText,
            firstRemoved.info.sessionID,
            firstRemoved.info.agent,
            keptWindow,
            stampedAny,
            { now: () => anchorTime, id },
          ),
        ];
  const compacted = [...anchorMessages, ...stampedUsers, ...keepSpan];
  if (estimateContentChars(compacted) >= estimateContentChars(working)) {
    return { summarizerError };
  }
  return {
    cut: {
      messages: compacted,
      compacted: true,
      removedCount: cutSpan.length - preservedUsers.length,
    },
    summarizerError,
  };
  });
}

/** Newest-first under budget, returned in original order; newest user message unconditional. */
function selectPreservedUsers(
  span: readonly Message.WithParts[],
  budgetChars: number,
): Message.WithParts[] {
  const users = span.filter((message) => message.info.role === "user" && !isAnchorMessage(message));
  const kept: Message.WithParts[] = [];
  let total = 0;
  for (let index = users.length - 1; index >= 0; index -= 1) {
    const candidate = users[index];
    if (candidate === undefined) continue;
    const size = messageContentChars(candidate);
    if (kept.length > 0 && total + size > budgetChars) break;
    kept.unshift(candidate);
    total += size;
  }
  return kept;
}

export function renderAnchorText(anchorBody: string, withMarkerLegend: boolean): string {
  return `${ANCHOR_HEADER}${anchorBody}${withMarkerLegend ? `\n\n${MARKER_LEGEND}` : ""}`;
}

function buildAnchorMessage(
  anchorBody: string,
  sessionID: string,
  agent: string,
  keptWindow: ReadonlyArray<{ role: "user" | "assistant"; text: string; time: number }>,
  withMarkerLegend: boolean,
  source: { readonly now: () => number; readonly id: () => string },
): Message.WithParts {
  const id = source.id();
  const now = source.now();
  const render = renderAnchorText(anchorBody, withMarkerLegend);
  const info: Message.UserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: now },
    agent,
    model: { providerID: "", modelID: "" },
    system: render,
  };
  const textPart: Message.TextPart = {
    id: source.id(),
    sessionID,
    messageID: id,
    type: "text",
    text: render,
    metadata: {
      compactionAnchor: true,
      anchorBody,
      // Content-borne: hydration flattens to role/content and re-mints ids, so an
      // id record would resolve to nothing. One oversized user message can ride
      // into every subsequent record by design — user tokens are irreplaceable.
      keptWindow,
    },
  };
  return { info, parts: [textPart] };
}
