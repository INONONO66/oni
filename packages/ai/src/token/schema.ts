import { z } from "zod";

/**
 * What a provider can put in an accounting slot before sanitizing: a JSON-shaped
 * tree whose numbers may be non-finite and whose optional fields may be explicit
 * undefined, as the SDK's usage and metadata objects are. `Count` decides what is usable.
 */
export type Reported =
  | undefined
  | null
  | boolean
  | number
  | string
  | Reported[]
  | { [key: string]: Reported };
const ReportedNumber = z.union([
  z.number(),
  z.nan(),
  z.literal(Number.POSITIVE_INFINITY),
  z.literal(Number.NEGATIVE_INFINITY),
]);
export const Reported: z.ZodType<Reported, Reported> = z.lazy(() =>
  z.union([
    z.undefined(),
    z.null(),
    z.boolean(),
    ReportedNumber,
    z.string(),
    z.array(Reported),
    z.record(z.string(), Reported),
  ]),
);

// Invalid-but-present counters remain present as undefined: aliases cannot repair contradictions.
const Count = z.number().int().nonnegative().safe().optional().catch(undefined);
const InputDetails = z.object({ cacheReadTokens: Count, cacheWriteTokens: Count }).catch({});
const OutputDetails = z.object({ reasoningTokens: Count }).catch({});
const Usage = z
  .object({
    inputTokens: Count,
    input_tokens: Count,
    promptTokens: Count,
    prompt_tokens: Count,
    outputTokens: Count,
    output_tokens: Count,
    completionTokens: Count,
    completion_tokens: Count,
    reasoningTokens: Count,
    reasoning_tokens: Count,
    cacheReadTokens: Count,
    cache_read_input_tokens: Count,
    cacheWriteTokens: Count,
    cache_creation_input_tokens: Count,
    inputTokenDetails: InputDetails,
    outputTokenDetails: OutputDetails,
    raw: z
      .object({ completion_tokens_details: z.object({ reasoning_tokens: Count }).catch({}) })
      .catch({ completion_tokens_details: {} }),
  })
  .catch({ inputTokenDetails: {}, outputTokenDetails: {}, raw: { completion_tokens_details: {} } });
const Metadata = z
  .object({
    anthropic: z
      .object({
        reasoningTokens: Count,
        cacheReadInputTokens: Count,
        cacheCreationInputTokens: Count,
      })
      .catch({}),
    openai: z.object({ reasoningTokens: Count, cachedPromptTokens: Count }).catch({}),
  })
  .catch({ anthropic: {}, openai: {} });

export const UsageResponse = z.object({ usage: Usage, providerMetadata: Metadata });
