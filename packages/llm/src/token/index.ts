import type { Token } from "@openomni/protocol";
import { UsageResponse, type Reported } from "./schema";

/** A step's locally estimated counts, in the same units as provider accounting. */
type UsageEstimate = {
  readonly inputTokens: number;
  readonly outputTokens: number;
};

/** The host can supply a tokenizer without adding one to the provider boundary. */
export type EstimateUsage = (serializedPrompt: string, emittedAssistant: string) => UsageEstimate;

export const estimateUsage: EstimateUsage = (serializedPrompt, emittedAssistant) => ({
  inputTokens: Math.ceil(serializedPrompt.length / 4),
  outputTokens: Math.ceil(emittedAssistant.length / 4),
});

/** Add billed usage, including failed attempts; auxiliary counts are not billed twice. */
export function accumulateUsage(total: Token.AgentUsage, usage: Token.ProviderUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.totalTokens += usage.inputTokens + usage.outputTokens;
  for (const key of ["reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    const count = usage[key] ?? 0;
    if (count > 0) total[key] = (total[key] ?? 0) + count;
  }
}

export namespace TokenTracker {
  /** Required unusable counts stay undefined so the fold estimates them, never silently zeroes. */
  export function extractUsage(response: {
    readonly usage?: Reported;
    readonly providerMetadata?: Reported;
  }): Omit<Token.ProviderUsage, "inputTokens" | "outputTokens"> & {
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
  } {
    const parsed = UsageResponse.parse(response);
    const { usage } = parsed;
    const metadata = parsed.providerMetadata;
    const input = usage.inputTokenDetails;
    const output = usage.outputTokenDetails;
    return {
      inputTokens: requiredCount(usage, [
        "inputTokens",
        "input_tokens",
        "promptTokens",
        "prompt_tokens",
      ]),
      outputTokens: requiredCount(usage, [
        "outputTokens",
        "output_tokens",
        "completionTokens",
        "completion_tokens",
      ]),
      reasoningTokens: firstCount(
        output.reasoningTokens,
        usage.reasoningTokens,
        usage.reasoning_tokens,
        usage.raw.completion_tokens_details.reasoning_tokens,
        metadata.anthropic.reasoningTokens,
        metadata.openai.reasoningTokens,
      ),
      cacheReadTokens: firstCount(
        input.cacheReadTokens,
        usage.cacheReadTokens,
        usage.cache_read_input_tokens,
        metadata.anthropic.cacheReadInputTokens,
        metadata.openai.cachedPromptTokens,
      ),
      cacheWriteTokens: firstCount(
        input.cacheWriteTokens,
        usage.cacheWriteTokens,
        usage.cache_creation_input_tokens,
        metadata.anthropic.cacheCreationInputTokens,
      ),
    };
  }
}

function firstCount(...values: Array<number | undefined>): number {
  return values.find((value) => value !== undefined) ?? 0;
}

/** Presence, not validity, decides which required alias owns the count. */
function requiredCount<Key extends string>(
  usage: Partial<Record<Key, number | undefined>>,
  keys: readonly Key[],
): number | undefined {
  for (const key of keys) {
    if (key in usage) return usage[key];
  }
  return undefined;
}
