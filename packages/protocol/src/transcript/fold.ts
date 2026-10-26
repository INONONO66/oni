import { z } from "zod";
import type { Message } from "../message/index.js";
import type * as Schema from "./schema.js";

/**
 * Pure deterministic Transcript fold (#545): projects an append-only fact
 * stream into Message.WithParts. Time (`at`) is an input — no ambient clock
 * read, no randomness. Facts are immutable records, so the fold may share fact
 * objects into the returned state; it never mutates its inputs and every
 * applied outcome is a new state object. A rejection is a recording defect
 * (bad fact order), not a recoverable branch — the ledger projector throws
 * on it loudly.
 *
 * Rule order is pinned (each earlier rule wins):
 *   1. created-on-existing  -> rejected invalid_transition (a message id is
 *                              created exactly once; message.created on
 *                              undefined state is the only way to open one;
 *                              an info born already finished also rejects —
 *                              the defect is caught at its origin)
 *   2. message identity     -> rejected unknown_message (any non-created fact
 *                              on undefined state or a mismatched messageId)
 *   3. finished guard       -> rejected already_finished (any fact addressed
 *                              to a finished message, including a second
 *                              message.finished)
 *   4. part identity        -> rejected unknown_part (part.advanced on an
 *                              absent partId)
 *   5. transition legality  -> rejected invalid_transition (per part type:
 *                              tool pending→running→completed|error|interrupted;
 *                              text/reasoning accept only "completed"; all
 *                              other part types are punctual and never
 *                              advance; re-advancing a terminal part rejects;
 *                              closing a running part with at < time.start
 *                              rejects; appended parts must be born
 *                              non-terminal — tool parts pending, text/
 *                              reasoning parts without time.end; appending a
 *                              duplicate partId or a part stamped with a
 *                              foreign messageID/sessionID rejects; finishing
 *                              a user message rejects)
 *   6. apply                -> new state objects, inputs never mutated
 */

const RejectReason = z.enum([
  "unknown_message",
  "unknown_part",
  "invalid_transition",
  "already_finished",
]);
type RejectReason = z.infer<typeof RejectReason>;

export type FoldOutcome =
  | { applied: true; state: Message.WithParts }
  | { rejected: true; reason: RejectReason };

function reject(reason: RejectReason): FoldOutcome {
  return { rejected: true, reason };
}

/** A message is finished once message.finished stamped its finish reason. */
function isFinished(info: Message.Info): boolean {
  return info.role === "assistant" && info.finish !== undefined;
}

export function fold(state: Message.WithParts | undefined, fact: Schema.Fact): FoldOutcome {
  if (fact.type === "message.created") {
    if (state !== undefined || isFinished(fact.message)) {
      return reject("invalid_transition");
    }
    return { applied: true, state: { info: fact.message, parts: [] } };
  }
  if (state === undefined || state.info.id !== fact.messageId) {
    return reject("unknown_message");
  }
  if (isFinished(state.info)) {
    return reject("already_finished");
  }
  switch (fact.type) {
    case "part.appended": {
      if (fact.part.messageID !== fact.messageId || fact.part.sessionID !== state.info.sessionID) {
        return reject("invalid_transition");
      }
      if (state.parts.some((part) => part.id === fact.part.id)) {
        return reject("invalid_transition");
      }
      if (!isAppendableInitialState(fact.part)) {
        return reject("invalid_transition");
      }
      return { applied: true, state: { info: state.info, parts: [...state.parts, fact.part] } };
    }
    case "part.advanced": {
      const index = state.parts.findIndex((part) => part.id === fact.partId);
      const part = state.parts[index];
      if (part === undefined) {
        return reject("unknown_part");
      }
      const advanced = advancePart(part, fact.transition);
      if (advanced === undefined) {
        return reject("invalid_transition");
      }
      const parts = [...state.parts];
      parts[index] = advanced;
      return { applied: true, state: { info: state.info, parts } };
    }
    case "message.finished":
      if (state.info.role !== "assistant") {
        return reject("invalid_transition");
      }
      return {
        applied: true,
        state: {
          info: {
            ...state.info,
            time: { ...state.info.time, completed: fact.at },
            finish: fact.finish,
            tokens: {
              input: fact.usage.input,
              output: fact.usage.output,
              reasoning: fact.usage.reasoning,
              cache: {
                read: fact.usage.cache.read,
                write: fact.usage.cache.write,
              },
            },
          },
          parts: [...state.parts],
        },
      };
  }
}

/**
 * Appended parts must be born non-terminal so every lifecycle step flows
 * through part.advanced: tool parts start pending, text/reasoning parts start
 * without an end time. Punctual part types (step and file) are complete at birth by nature.
 */
function isAppendableInitialState(part: Message.Part): boolean {
  switch (part.type) {
    case "tool":
      return part.state.status === "pending";
    case "text":
    case "reasoning":
      return part.time?.end === undefined;
    case "step-start":
    case "step-finish":
    case "file":
      return true;
  }
}

/** Returns the advanced part, or undefined when the transition is illegal. */
function advancePart(
  part: Message.Part,
  transition: Schema.PartTransition,
): Message.Part | undefined {
  switch (part.type) {
    case "tool":
      return advanceToolPart(part, transition);
    case "text":
    case "reasoning":
      return advanceTextLikePart(part, transition);
    case "step-start":
    case "step-finish":
    case "file":
      // Punctual parts: appended whole, never advanced.
      return undefined;
  }
}

/**
 * Maps a transition onto the part's Tool.State equivalent. The legal chain is
 * pending → running → completed | error | interrupted; anything else —
 * skipping "running", re-advancing a terminal state — is illegal.
 *
 * "interrupted" projects onto Tool.StateError with error "interrupted":
 * Tool.State has no interrupted status and growing it needs a consumer (T2).
 * The fact stream remains the source of truth for `partialOutput` — the
 * folded projection is deliberately lossy there until then.
 */
function advanceToolPart(
  part: Message.ToolPart,
  transition: Schema.PartTransition,
): Message.ToolPart | undefined {
  const state = part.state;
  switch (transition.to) {
    case "running": {
      if (state.status !== "pending") {
        return undefined;
      }
      return {
        ...part,
        state: {
          status: "running",
          input: state.input,
          time: { start: transition.at },
        },
      };
    }
    case "completed": {
      if (state.status !== "running" || transition.at < state.time.start) {
        return undefined;
      }
      return {
        ...part,
        state: {
          status: "completed",
          input: state.input,
          output: transition.output,
          title: transition.title ?? part.tool,
          metadata: {},
          time: { start: state.time.start, end: transition.at },
        },
      };
    }
    case "error": {
      if (state.status !== "running" || transition.at < state.time.start) {
        return undefined;
      }
      return {
        ...part,
        state: {
          status: "error",
          input: state.input,
          error: transition.error,
          time: { start: state.time.start, end: transition.at },
        },
      };
    }
    case "interrupted":
      if (state.status !== "running" || transition.at < state.time.start) {
        return undefined;
      }
      return {
        ...part,
        state: {
          status: "error",
          input: state.input,
          error: "interrupted",
          time: { start: state.time.start, end: transition.at },
        },
      };
  }
}

/**
 * Text and reasoning parts have no intermediate states: the only legal
 * transition is "completed", which stamps the authoritative final text and
 * the end time. A part whose time.end is set is terminal. The provider
 * reasoning signature rides the completed transition (it arrives at stream
 * end) and projects onto reasoning parts only.
 */
function advanceTextLikePart(
  part: Message.TextPart | Message.ReasoningPart,
  transition: Schema.PartTransition,
): Message.Part | undefined {
  if (transition.to !== "completed") {
    return undefined;
  }
  if (part.time?.end !== undefined) {
    return undefined;
  }
  const start = part.type === "reasoning" ? part.time.start : (part.time?.start ?? transition.at);
  if (transition.at < start) {
    return undefined;
  }
  if (part.type === "reasoning") {
    return {
      ...part,
      text: transition.output,
      ...(transition.signature !== undefined ? { signature: transition.signature } : {}),
      time: { start, end: transition.at },
    };
  }
  return {
    ...part,
    text: transition.output,
    time: { start, end: transition.at },
  };
}
