import type { Message } from "@openomni/protocol";
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

export function prepareSummarizerInput(
  messages: readonly Message.WithParts[],
  contextWindowTokens: number,
): { readonly messages: Message.WithParts[]; readonly budget: SummarizationBudget } {
  const halfWindow = Math.max(0, Math.floor(contextWindowTokens * 0.5));
  const budget = {
    maxInputTokens: halfWindow,
    maxOutputTokens: Math.min(32_768, halfWindow),
    contextWindowTokens,
  };
  // The budget advises the summarizer; rewriting the supplied prefix breaks cache identity.
  return { messages: [...messages], budget };
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
