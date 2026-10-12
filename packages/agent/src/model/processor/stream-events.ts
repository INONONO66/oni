import type { Message, PlainObject, Transcript } from "@openomni/protocol";
import type { Sink } from "../sink";
import { appendPart, advancePart, handleToolCall, handleToolResult } from "./tool-events";
import { TokenTracker, type EstimateUsage } from "../token";
import { ProviderEvent, Signature, type StreamEvent } from "./event-schema";
import { normalizeEvent } from "./normalize";

export type { StreamEvent } from "./event-schema";

export type StreamEventContext = {
  readonly sessionID: string;
  readonly messageID: string;
  readonly attemptId: string;
  readonly sink: Sink;
  /**
   * Records one transcript fact: folds it into the processor's attempt state
   * (loud-throw on rejection — a bad fact order is a recording defect) and
   * emits the part-boundary snapshot when the fact is a boundary.
   */
  readonly record: (fact: Transcript.Fact) => void;
  /** Debug note for normalized-away provider anomalies (#532-6). */
  readonly note: (msg: string, data?: PlainObject) => void;
  /**
   * Wire tool name → internal dotted name. The provider echoes the sanitized
   * wire name on stream events; this restores the dotted internal name on the
   * recorded part so the transcript keeps the native vocabulary. Absent =
   * record the name verbatim.
   */
  readonly toolNames?: ReadonlyMap<string, string>;
  readonly externalTools?: boolean;
  /**
   * The step's prompt text as it crossed to the provider. The local estimator's
   * input-token source when the provider's own input count is unusable (#933).
   */
  readonly promptText: string;
  /** Local usage estimator for steps whose provider accounting is unusable (#933). */
  readonly estimateUsage: EstimateUsage;
  /** Wall-clock source for part timestamps (#1245). */
  readonly now: () => number;
  /** Unique-id source for part identities (#1245). */
  readonly id: () => string;
};

type OpenBlock = {
  partId: string;
  text: string;
  signature?: string;
};

export type StreamEventState = {
  currentText?: OpenBlock;
  reasoning: Map<string, OpenBlock>;
  pendingTools: Map<string, string>;
  usage: Transcript.Usage;
  usageProvenance: "reported" | "estimated" | "unknown";
  /**
   * Assistant output this step emitted — text, reasoning, and tool-call JSON —
   * the local estimator's output-token source. Reset at each step-finish so
   * per-step estimates stay additive with the per-step provider counts (#933).
   */
  stepEmittedAssistant: string;
  finishReason?: string;
  visibleOutput: boolean;
};

export function createStreamEventState(): StreamEventState {
  return {
    reasoning: new Map(),
    pendingTools: new Map(),
    usage: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    usageProvenance: "unknown",
    stepEmittedAssistant: "",
    visibleOutput: false,
  };
}

/**
 * Provider finish reason → transcript finish vocabulary, mapped exactly
 * (#532-7): length and content-filter/error finishes are never rewritten to
 * "stop". The transcript vocabulary has no content-filter value, so a
 * filtered turn closes as "error" — abnormal stays abnormal. The step-finish
 * part stores the ai-unified finishReason (e.g. "tool-calls"), not the raw
 * provider string — the agent's yield detector reads exactly that vocabulary.
 */
export function mapFinishReason(reason: string | undefined): Transcript.FinishReason {
  switch (reason) {
    case "length":
    case "max_tokens":
      return "length";
    case "error":
    case "content-filter":
    case "content_filter":
      return "error";
    default:
      // stop, end_turn, tool-calls, tool_use, other, unknown, absent.
      return "stop";
  }
}

export function handleStreamEvent(
  event: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  for (const normalized of normalizeEvent(ProviderEvent.parse(event), state, context)) {
    applyStreamEvent(normalized, state, context);
  }
}

function applyStreamEvent(
  event: ProviderEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  switch (event.type) {
    case "text-start": {
      startText(event, state, context);
      break;
    }
    case "text-delta": {
      // Per-token cost is O(1): the delta only grows an internal buffer.
      const text = String(event.text || "");
      if (text.length > 0) state.visibleOutput = true;
      state.stepEmittedAssistant += text;
      if (state.currentText) {
        state.currentText.text += text;
      }
      break;
    }
    case "text-end": {
      finishText(state, context);
      break;
    }
    case "reasoning-start": {
      startReasoning(event, state, context);
      break;
    }
    case "reasoning-delta": {
      appendReasoning(event, state);
      break;
    }
    case "reasoning-end": {
      finishReasoning(event, state, context);
      break;
    }
    case "tool-call": {
      handleToolCall(event, state, context);
      break;
    }
    case "tool-result": {
      handleToolResult(event, state, context);
      break;
    }
    case "tool-error": {
      handleToolResult({ ...event, type: "tool-result", isError: true }, state, context);
      break;
    }
    case "step-start": {
      appendPart(
        {
          id: context.id(),
          sessionID: context.sessionID,
          messageID: context.messageID,
          type: "step-start",
        },
        context,
      );
      break;
    }
    case "step-finish": {
      handleStepFinish(event, state, context);
      break;
    }
    case "finish": {
      break;
    }
    case "error": {
      throw event.error;
    }
    default:
  }
}

function startText(
  event: ProviderEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const part: Message.TextPart = {
    id: context.id(),
    sessionID: context.sessionID,
    messageID: context.messageID,
    type: "text",
    text: "",
    time: { start: context.now() },
    metadata: event.providerMetadata ?? {},
  };
  state.currentText = { partId: part.id, text: "" };
  appendPart(part, context);
}

function finishText(state: StreamEventState, context: StreamEventContext): void {
  const open = state.currentText;
  if (open === undefined) return;
  state.currentText = undefined;
  advancePart(
    open.partId,
    { to: "completed", at: context.now(), output: open.text.trimEnd() },
    context,
  );
}

function startReasoning(
  event: ProviderEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const part: Message.ReasoningPart = {
    id: context.id(),
    sessionID: context.sessionID,
    messageID: context.messageID,
    type: "reasoning",
    text: "",
    time: { start: context.now(), end: undefined },
    metadata: event.providerMetadata ?? {},
  };
  state.reasoning.set(String(event.id), { partId: part.id, text: "" });
  appendPart(part, context);
}

function appendReasoning(event: ProviderEvent, state: StreamEventState): void {
  const open = state.reasoning.get(String(event.id));
  if (open === undefined) return;
  const text = String(event.text || "");
  // Reasoning is billed inside the provider's output count, so the estimator's
  // output source includes it (`reasoningTokens` stays the auxiliary split).
  state.stepEmittedAssistant += text;
  open.text += text;
  const signature = extractSignature(event.providerMetadata);
  if (signature !== undefined) open.signature = signature;
}

function finishReasoning(
  event: ProviderEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const reasoningId = String(event.id);
  const open = state.reasoning.get(reasoningId);
  if (open === undefined) return;
  state.reasoning.delete(reasoningId);
  const signature = extractSignature(event.providerMetadata) ?? open.signature;
  advancePart(
    open.partId,
    {
      to: "completed",
      at: context.now(),
      output: open.text.trimEnd(),
      ...(signature !== undefined ? { signature } : {}),
    },
    context,
  );
}

/**
 * The provider reasoning signature rides providerMetadata (Anthropic emits it
 * as a trailing empty reasoning-delta with {anthropic:{signature}}). Scan the
 * namespaces so the capture is provider-agnostic.
 */
function extractSignature(providerMetadata: ProviderEvent["providerMetadata"]): string | undefined {
  for (const value of Object.values(providerMetadata ?? {})) {
    const parsed = Signature.safeParse(value);
    if (parsed.success && parsed.data.signature !== undefined) return parsed.data.signature;
  }
  return undefined;
}

function handleStepFinish(
  event: ProviderEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const finishReason = String(event.finishReason || "end_turn");
  const provider = TokenTracker.extractUsage({
    usage: event.usage,
    providerMetadata: event.providerMetadata,
  });
  // KERNEL §5.3: provider accounting combined with a local estimate. A usable
  // provider count stays authoritative (a reported 0 included); an unusable one
  // — absent, wrong-typed, or outside the count domain — is replaced field-wise
  // by the local estimate, so a real model step never folds to a trusted zero.
  const estimate = context.estimateUsage(context.promptText, state.stepEmittedAssistant);
  const usage = {
    inputTokens: provider.inputTokens ?? estimate.inputTokens,
    outputTokens: provider.outputTokens ?? estimate.outputTokens,
    reasoningTokens: provider.reasoningTokens,
    cacheReadTokens: provider.cacheReadTokens,
    cacheWriteTokens: provider.cacheWriteTokens,
  };
  state.usageProvenance =
    state.usageProvenance === "estimated" ||
    provider.inputTokens === undefined || provider.outputTokens === undefined
      ? "estimated" : "reported";

  state.finishReason = finishReason;
  state.stepEmittedAssistant = "";
  state.usage = {
    input: state.usage.input + usage.inputTokens,
    output: state.usage.output + usage.outputTokens,
    reasoning: state.usage.reasoning + (usage.reasoningTokens ?? 0),
    cache: {
      read: state.usage.cache.read + (usage.cacheReadTokens ?? 0),
      write: state.usage.cache.write + (usage.cacheWriteTokens ?? 0),
    },
  };

  // #532-7: a length-truncated step cannot have completed its tool calls —
  // fail every non-terminal tool part now, no salvage.
  if (mapFinishReason(finishReason) === "length") {
    const at = context.now();
    for (const [callID, partId] of state.pendingTools) {
      if (context.externalTools) advancePart(partId, { to: "running", at }, context);
      advancePart(
        partId,
        { to: "error", at, error: "truncated output: tool call incomplete" },
        context,
      );
      context.sink.onToolResult({
        id: context.id(),
        toolCallId: callID,
        content: "truncated output: tool call incomplete",
        isError: true,
      });
    }
    state.pendingTools.clear();
  }

  appendPart(
    {
      id: context.id(),
      sessionID: context.sessionID,
      messageID: context.messageID,
      type: "step-finish",
      reason: finishReason,
      tokens: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        reasoning: usage.reasoningTokens ?? 0,
        cache: {
          read: usage.cacheReadTokens ?? 0,
          write: usage.cacheWriteTokens ?? 0,
        },
      },
    },
    context,
  );
}

/**
 * Closes everything the attempt left open, as facts, before the attempt's
 * message.finished. Text and reasoning close as completed with whatever
 * partial output the buffer holds — "interrupted" is tool-only vocabulary in
 * T1. Tools follow the #543 grace-settle semantics: after the abort grace
 * expires they advance to interrupted (the tool may have produced a real
 * side effect we can no longer observe); on every other unsettled exit
 * (clean stream end after isStepCount, retryable failure, non-retryable
 * error) they advance to error.
 */
export function settleAttempt(
  state: StreamEventState,
  context: StreamEventContext,
  options: { aborted: boolean; preserveTools?: boolean },
): void {
  finishText(state, context);
  for (const reasoningId of [...state.reasoning.keys()]) {
    finishReasoning({ type: "reasoning-end", id: reasoningId }, state, context);
  }
  if (options.preserveTools) return;
  const at = context.now();
  for (const [callID, partId] of state.pendingTools) {
    if (context.externalTools) advancePart(partId, { to: "running", at }, context);
    advancePart(
      partId,
      options.aborted
        ? { to: "interrupted", at }
        : { to: "error", at, error: "Processing was interrupted" },
      context,
    );
    context.sink.onToolResult({
      id: context.id(),
      toolCallId: callID,
      content: "Processing was interrupted",
      isError: true,
    });
  }
  state.pendingTools.clear();
}
