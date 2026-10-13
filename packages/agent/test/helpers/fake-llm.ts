import { Effect, Layer } from "effect";
import {
  type FailureClass,
  type FailureFacts,
  Llm,
  type LlmPort,
  type ResolvedModel,
  isLlmRunFailure,
} from "../../src/core/llm";

/**
 * The test binding of the core's LLM port (#1352). The suite never loads the
 * provider SDK: provider facts a real call would carry on the SDK error ride
 * on {@link FakeProviderError}, and {@link fakeClassifyFailure} is the
 * fake's own pure reading of them. The classification VOCABULARY is the
 * port's; the decision over it (delay, cap, streak, fallback) stays in the
 * core and is what the agent tests exercise.
 */
export class FakeProviderError extends Error {
  override readonly name = "FakeProviderError";
  readonly statusCode: number | undefined;
  readonly isRetryable: boolean;
  readonly responseHeaders: Record<string, string> | undefined;

  constructor(input: { message: string; statusCode?: number; isRetryable?: boolean; responseHeaders?: Record<string, string> }) {
    super(input.message);
    this.statusCode = input.statusCode;
    this.isRetryable = input.isRetryable ?? true;
    this.responseHeaders = input.responseHeaders;
  }
}

/** The ratio the real port names once; the fake mirrors it so window tests mean the same thing on both bindings. */
const NEAR_WINDOW_RATIO = 0.99;

function providerCause(error: unknown): FakeProviderError | undefined {
  if (error instanceof FakeProviderError) return error;
  return isLlmRunFailure(error) && error.cause instanceof FakeProviderError ? error.cause : undefined;
}

function usageOverflows(facts: FailureFacts): boolean {
  const { usage, contextWindow } = facts;
  if (usage === undefined || contextWindow === undefined || contextWindow <= 0) return false;
  const prompt = usage.inputTokens + (usage.cacheReadTokens ?? 0);
  if (facts.finishReason === "length") return usage.outputTokens === 0 && prompt >= contextWindow * NEAR_WINDOW_RATIO;
  return (facts.finishReason === "stop" || facts.finishReason === undefined) && prompt > contextWindow;
}

export function fakeClassifyFailure(facts: FailureFacts): FailureClass {
  const error = facts.error;
  if (isLlmRunFailure(error) && error.aborted) return { kind: "aborted" };
  if (error instanceof Error && error.name === "AbortError") return { kind: "aborted" };
  if (isLlmRunFailure(error) && error.contextOverflow) return { kind: "overflow" };
  if (usageOverflows(facts)) return { kind: "overflow" };
  const cause = providerCause(error);
  const status = cause?.statusCode;
  const reason = status === 408 ? "timeout" : cause === undefined || cause.isRetryable ? "transient_error" : "validation_error";
  // Mirrors the real classifier: a failure without a provider cause is terminal, never a retry input.
  if (cause === undefined) return { kind: "terminal", reason, providerReason: "non_retryable", status: undefined };
  if (!cause.isRetryable) {
    const providerReason = status === 402 ? "billing" : "non_retryable";
    return { kind: "terminal", reason, providerReason, status };
  }
  const after = cause?.responseHeaders?.["retry-after-ms"];
  return {
    kind: "retryable",
    reason,
    providerReason: status === 429 ? "rate_limit" : "server_error",
    afterMs: after === undefined ? undefined : Number(after),
    directed: after === undefined ? undefined : true,
    instant: status === undefined && cause.responseHeaders === undefined,
  };
}

export const fakeResolvedModel: ResolvedModel = {
  id: "claude-3-haiku-20240307",
  name: "Claude 3 Haiku",
  providerID: "anthropic",
};

/** A complete port: every member answers; a fixture overrides only what it exercises. */
export function fakeLlm(overrides: Partial<LlmPort> = {}): LlmPort {
  return {
    resolveModel: () => Effect.succeed(fakeResolvedModel),
    run: () => Effect.succeed({ type: "stop" }),
    classifyFailure: fakeClassifyFailure,
    ...overrides,
  };
}

/** The suite-wide binding of the port tag. */
export const FakeLlmLive = Layer.succeed(Llm, fakeLlm());
