import type { Message } from "@openomni/protocol";
import type { Provider } from "../../../src/model/provider";

/** Fixed wall clock for injected `now` stubs: 2025-01-01T00:00:00Z. */
export const FIXED_NOW = 1_735_689_600_000;
export const fixedNow = (): number => FIXED_NOW;
/** Deterministic unique-id stub for injected `id` sources. */
export function sequentialIds(prefix = "fixed-id"): () => string {
  let counter = 0;
  return () => { counter += 1; return `${prefix}-${counter}`; };
}

export const anthropicModel: Provider.Model = {
  id: "claude-3-5-sonnet",
  providerID: "anthropic",
  name: "Claude 3.5 Sonnet",
  api: { npm: "@ai-sdk/anthropic" },
};

export function assistantMessage(
  id: string,
  sessionID: string,
  parentID = `parent-${id}`,
): Message.AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: FIXED_NOW },
    parentID,
    modelID: anthropicModel.id,
    providerID: anthropicModel.providerID,
    agent: "test-agent",
    path: { cwd: "/test", root: "/" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}
