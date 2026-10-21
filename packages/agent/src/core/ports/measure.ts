import type { Message } from "@oni/protocol";

/**
 * The last step-finish part's input tokens: provider-measured when usable,
 * else llm's local estimate. `message.info.tokens` sums every step and the
 * cache lanes are already folded into `input`, so neither is the window.
 * Undefined when no step finished — the caller records nothing, not a guess.
 */
export function measuredContextTokens(message: Message.WithParts): number | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part?.type === "step-finish") return part.tokens.input;
  }
  return undefined;
}
