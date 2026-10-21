import type { Message } from "@oni/protocol";
import type { SummarizationBudget, ResolvedCompactionOptions } from "./contract";
import { resolveCompactionGeometry, type CompactionYield } from "./geometry";

// Only decides the cut's eagerness after an elision round — never the trigger.
export const ESTIMATED_CHARS_PER_TOKEN = 4;

const BASE64_RUN_RE = /[A-Za-z0-9+/=_-]{512,}/g;

export function messageContentChars(message: Message.WithParts): number {
  // All content weighs against the budget, including tool-bulked user messages.
  let chars = 0;
  for (const part of message.parts) {
    if (part.type === "text") chars += part.text.length;
    else if (part.type === "tool" && part.state.status === "completed") {
      chars += part.state.output.length;
    }
  }
  return chars;
}

/**
 * Window-size proxy for the progress guard: the same content classes the
 * model projection actually resends (text and completed tool outputs).
 */
export function estimateContentChars(span: readonly Message.WithParts[]): number {
  let chars = 0;
  for (const message of span) {
    chars += messageContentChars(message);
  }
  return chars;
}

function weightedTextChars(text: string): number {
  let weighted = text.length;
  for (const match of text.matchAll(BASE64_RUN_RE)) weighted += match[0].length * 3;
  return weighted;
}

function weightedMessageChars(message: Message.WithParts): number {
  let weightedChars = 0;
  for (const part of message.parts) {
    if (part.type === "text") weightedChars += weightedTextChars(part.text);
    else if (part.type === "tool" && part.state.status === "completed") {
      weightedChars += weightedTextChars(part.state.output);
    }
  }
  return weightedChars;
}

export function estimateMessagesTokens(messages: readonly Message.WithParts[]): number {
  let weightedChars = 0;
  for (const message of messages) weightedChars += weightedMessageChars(message);
  return Math.ceil(weightedChars / ESTIMATED_CHARS_PER_TOKEN);
}

export function isIneffectiveCompaction(savedTokens: number, tokensBefore: number): boolean {
  return savedTokens < 1024 || savedTokens / Math.max(1, tokensBefore) < 0.1;
}

/** The unchanged prefix when it fits beside the anchor and output reserve; else the bounded input. */
export function prepareSummarizerInput(
  prefix: readonly Message.WithParts[],
  contextWindowTokens: number,
  previousAnchor?: string,
): { readonly messages: Message.WithParts[]; readonly budget: SummarizationBudget } {
  const halfWindow = Math.max(0, Math.floor(contextWindowTokens * 0.5));
  const maxOutputTokens = Math.min(32_768, halfWindow);
  const budget = { maxInputTokens: halfWindow, maxOutputTokens, contextWindowTokens };
  const anchorTokens = Math.ceil(weightedTextChars(previousAnchor ?? "") / ESTIMATED_CHARS_PER_TOKEN);
  if (estimateMessagesTokens(prefix) + anchorTokens + maxOutputTokens <= contextWindowTokens) {
    return { messages: [...prefix], budget };
  }

  const messageBudget = Math.max(0, halfWindow - anchorTokens);
  const elided = prefix.filter((message) => message.info.role !== "user").map((message) => {
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return part;
      const marker = `[tool output elided for summarization: ${part.state.output.length} chars]`;
      if (marker.length >= part.state.output.length) return part;
      changed = true;
      return { ...part, state: { ...part.state, output: marker } };
    });
    return changed ? { ...message, parts } : message;
  });
  const weights = elided.map(weightedMessageChars);
  let suffixChars = 0;
  for (const weight of weights) suffixChars += weight;
  let first = 0;
  while (first < elided.length && Math.ceil(suffixChars / ESTIMATED_CHARS_PER_TOKEN) > messageBudget) {
    suffixChars -= weights[first] ?? 0;
    first += 1;
  }
  return { messages: elided.slice(first), budget };
}

export function resolveThresholdTokens(
  options: ResolvedCompactionOptions,
  previousYield?: CompactionYield,
): number {
  return resolveCompactionGeometry({
    contextWindowTokens: options.contextWindowTokens,
    ...(options.reserveTokens === undefined ? {} : { reserveTokens: options.reserveTokens }),
    ...(previousYield === undefined ? {} : { previousYield }),
  }).thresholdTokens;
}
