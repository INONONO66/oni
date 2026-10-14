import type { Message } from "@openomni/protocol";
import type { CompactionCandidate } from "./speculate";

// A summary sees the original leading prefix; preservation is decided separately.
export function planAnchoredCut(
  messages: readonly Message.WithParts[],
  protectRecentMessages: number,
):
  | {
      readonly prefixIds: readonly string[];
      readonly prefixFingerprint: string;
      readonly previousAnchor: string | undefined;
      readonly summarizerInput: Message.WithParts[];
    }
  | undefined {
  if (messages.length <= protectRecentMessages) return undefined;
  const cutoff = messages.length - protectRecentMessages;
  if (cutoff <= 0) return undefined;
  const toRemove = messages.slice(0, cutoff);
  if (!toRemove.some((message) => message.info.role !== "user" && !isAnchorMessage(message)))
    return undefined;
  return {
    prefixIds: toRemove.map((message) => message.info.id),
    prefixFingerprint: canonicalPrefixFingerprint(toRemove),
    previousAnchor: latestAnchorBody(toRemove),
    summarizerInput: toRemove,
  };
}

function anchorPart(message: Message.WithParts): Message.TextPart | undefined {
  if (message.info.role !== "user") return undefined;
  return message.parts.find(
    (part: Message.Part): part is Message.TextPart =>
      part.type === "text" && part.metadata?.compactionAnchor === true,
  );
}

export function isAnchorMessage(message: Message.WithParts): boolean {
  return anchorPart(message) !== undefined;
}

export function latestCompactionAnchorId(span: readonly Message.WithParts[]): string | undefined {
  for (let index = span.length - 1; index >= 0; index -= 1) {
    const message = span[index];
    if (message !== undefined && isAnchorMessage(message)) return message.info.id;
  }
  return undefined;
}

export function isWarmCandidateValid(
  candidate: CompactionCandidate,
  messages: readonly Message.WithParts[],
): boolean {
  const cut = messages.findIndex((message) => message.info.id === candidate.firstKeptId);
  if (cut !== candidate.prefixIds.length) return false;
  if (latestCompactionAnchorId(messages) !== candidate.compactionAnchorId) return false;
  if (!candidate.prefixIds.every((id, index) => messages[index]?.info.id === id)) return false;
  return (
    canonicalPrefixFingerprint(messages.slice(0, candidate.prefixIds.length)) ===
    candidate.prefixFingerprint
  );
}

function canonicalPartContent(part: Message.Part) {
  if (part.type === "text") return { type: part.type, text: part.text, metadata: part.metadata };
  if (part.type === "reasoning") {
    return { type: part.type, text: part.text, signature: part.signature, metadata: part.metadata };
  }
  if (part.type === "step-start") return { type: part.type };
  if (part.type === "step-finish") {
    return { type: part.type, reason: part.reason, tokens: part.tokens };
  }
  const state =
    part.state.status === "completed" ? { ...part.state, output: "[tool output]" } : part.state;
  return { type: part.type, callID: part.callID, tool: part.tool, state };
}

function canonicalPrefixFingerprint(messages: readonly Message.WithParts[]): string {
  const canonical = JSON.stringify(
    messages.map((message) => ({
      role: message.info.role,
      parts: message.parts.map(canonicalPartContent),
    })),
  );
  let hash = 2_166_136_261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function latestAnchorBody(span: readonly Message.WithParts[]): string | undefined {
  for (let index = span.length - 1; index >= 0; index -= 1) {
    const message = span[index];
    if (message === undefined) continue;
    const part = anchorPart(message);
    if (part === undefined) continue;
    const body = part.metadata?.anchorBody;
    // Corrupt or foreign renders retain their visible text.
    return typeof body === "string" ? body : part.text;
  }
  return undefined;
}
