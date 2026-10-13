import { describe, expect, it } from "bun:test";
import { TokenTracker, estimateUsage } from "../../../src/model/token";

/**
 * `expected` is `[inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens]`. The required
 * input/output slots are `undefined` when the provider's accounting is unusable (absent, wrong-typed, or
 * invalid-numeric): that is a distinct value from a reported `0`, and the step-finish fold turns it into a local
 * estimate instead of a trusted zero.
 */
const usageCases: Array<{
  name: string;
  response: Parameters<typeof TokenTracker.extractUsage>[0];
  expected: [number | undefined, number | undefined, number, number, number];
}> = [
  {
    name: "extracts AI SDK usage format",
    response: {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: { noCacheTokens: 90, cacheReadTokens: 7, cacheWriteTokens: 3 },
        outputTokenDetails: { textTokens: 44, reasoningTokens: 6 },
        totalTokens: 150,
      },
    },
    expected: [100, 50, 6, 7, 3],
  },
  {
    name: "extracts Anthropic usage format",
    response: {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        reasoning_tokens: 12,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 3,
      },
    },
    expected: [100, 50, 12, 3, 7],
  },
  {
    name: "extracts OpenAI usage format",
    response: {
      usage: { prompt_tokens: 200, completion_tokens: 80 },
      providerMetadata: { openai: { reasoningTokens: 9 } },
    },
    expected: [200, 80, 9, 0, 0],
  },
  {
    name: "extracts reasoning tokens from raw OpenAI completion details",
    response: {
      usage: { raw: { completion_tokens_details: { reasoning_tokens: 17 } } },
    },
    expected: [undefined, undefined, 17, 0, 0],
  },
  {
    name: "keeps a legitimate zero instead of falling through to lower-priority aliases",
    response: {
      usage: {
        inputTokens: 0,
        input_tokens: 11,
        outputTokens: 0,
        output_tokens: 10,
        outputTokenDetails: { reasoningTokens: 0 },
        reasoningTokens: 12,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
        cacheReadTokens: 13,
        cacheWriteTokens: 14,
      },
    },
    expected: [0, 0, 0, 0, 0],
  },
  {
    name: "reports required counts as unusable when usage is missing",
    response: {},
    expected: [undefined, undefined, 0, 0, 0],
  },
  {
    name: "reports required counts as unusable for string and null values",
    response: {
      usage: {
        inputTokens: "100",
        outputTokens: null,
        reasoningTokens: false,
        cacheReadTokens: undefined,
        cacheWriteTokens: {},
      },
    },
    expected: [undefined, undefined, 0, 0, 0],
  },
  {
    name: "does not fall through from a wrong-typed alias to a lower-priority alias",
    response: {
      usage: {
        inputTokens: "100",
        input_tokens: 11,
        outputTokens: null,
        output_tokens: 10,
      },
    },
    expected: [undefined, undefined, 0, 0, 0],
  },
];

describe("TokenTracker.extractUsage", () => {
  it.each(usageCases)("$name", ({ response, expected }) => {
    const result = TokenTracker.extractUsage(response);
    expect(result.inputTokens).toBe(expected[0]);
    expect(result.outputTokens).toBe(expected[1]);
    expect(result.reasoningTokens).toBe(expected[2]);
    expect(result.cacheReadTokens).toBe(expected[3]);
    expect(result.cacheWriteTokens).toBe(expected[4]);
  });

  it.each([
    ["inputTokens", -1],
    ["inputTokens", Number.NaN],
    ["inputTokens", Number.POSITIVE_INFINITY],
    ["inputTokens", 1.5],
    ["inputTokens", Number.MAX_SAFE_INTEGER + 1],
    ["outputTokens", -1],
    ["outputTokens", Number.NaN],
    ["outputTokens", Number.POSITIVE_INFINITY],
    ["outputTokens", 1.5],
    ["outputTokens", Number.MAX_SAFE_INTEGER + 1],
  ] as const)("reports invalid numeric %s (%p) as unusable", (key, value) => {
    const result = TokenTracker.extractUsage({ usage: { [key]: value } });

    expect(result[key]).toBeUndefined();
  });

  it.each([
    ["reasoningTokens", Number.NaN],
    ["cacheReadTokens", -1],
    ["cacheWriteTokens", 1.5],
  ] as const)("drops invalid optional counter %s (%p) to zero", (key, value) => {
    const result = TokenTracker.extractUsage({ usage: { [key]: value } });

    expect(result[key]).toBe(0);
  });

  it("drops invalid provider-metadata counters instead of throwing", () => {
    const result = TokenTracker.extractUsage({
      providerMetadata: { anthropic: { cacheReadInputTokens: Number.NaN } },
    });

    expect(result.cacheReadTokens).toBe(0);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
  });
});

describe("estimateUsage", () => {
  it("is a deterministic ceil(chars/4) over prompt and emitted text", () => {
    // 9 chars → 3; 5 chars → 2. Ceil, so a partial 4-char group still counts.
    expect(estimateUsage("123456789", "12345")).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it("estimates zero only for genuinely empty text", () => {
    expect(estimateUsage("", "")).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(estimateUsage("a", "b")).toEqual({ inputTokens: 1, outputTokens: 1 });
  });

  it("counts each argument independently at exact boundaries", () => {
    // 11 chars -> 3, 14 chars -> 4: input and output read their own argument,
    // so swapping the sources or summing them changes these exact counts.
    expect(estimateUsage("prompt text", "assistant text")).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
    // Exact multiples of 4 do not round up.
    expect(estimateUsage("1234", "12345678")).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
});
