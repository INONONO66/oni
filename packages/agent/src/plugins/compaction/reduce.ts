import type { Message } from "@oni/protocol";

import type { ToolOutputElision } from "../../core/api";

interface ReductionResult {
  readonly messages: Message.WithParts[];
  readonly elidedChars: number;
}

/**
 * Old completed tool outputs become a sized elision marker plus a head
 * excerpt carrying the part's `callID`. Termination is structural: an output
 * is elided only when its replacement is strictly shorter, so a fixed point exists.
 */
export function elideToolOutputs(
  messages: readonly Message.WithParts[],
  protectRecentMessages: number,
  options: ToolOutputElision,
): ReductionResult {
  const cutoff = messages.length - protectRecentMessages;
  let elidedChars = 0;

  const reduced = messages.map((message, index) => {
    if (index >= cutoff) return message;
    // User-role messages are never rewritten, tool parts included: verbatim
    // preservation is a property of the whole message.
    if (message.info.role === "user") return message;
    let touched = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return part;
      if (part.state.output.length <= options.minOutputChars) return part;
      const output = elidedOutput(part.state.output, options.keepHeadChars, part.callID);
      if (output.length >= part.state.output.length) return part;
      elidedChars += part.state.output.length - output.length;
      touched = true;
      return { ...part, state: { ...part.state, output } };
    });
    return touched ? { ...message, parts } : message;
  });

  return elidedChars === 0
    ? { messages: [...messages], elidedChars: 0 }
    : { messages: reduced, elidedChars };
}

function elidedOutput(output: string, keepHeadChars: number, callID: string): string {
  return `[output elided by compaction: ${output.length} chars; recall: ${callID}]\n${output.slice(0, keepHeadChars)}`;
}
