import { Effect, Layer } from "effect";
import {
  type FailureClass,
  type FailureFacts,
  Llm,
  type LlmPort,
  type ResolvedModel,
  isLlmRunFailure,
} from "../../src/core/ports/llm";

/** A provider-shaped error with the verdict supplied by the test, not inferred from its fields. */
export class FakeProviderError extends Error {
  override readonly name = "FakeProviderError";
  readonly statusCode: number | undefined;
  readonly isRetryable: boolean;
  readonly responseHeaders: Record<string, string> | undefined;
  readonly failureClass: FailureClass | undefined;

  constructor(input: { message: string; statusCode?: number; isRetryable?: boolean; responseHeaders?: Record<string, string>; failureClass?: FailureClass }) {
    super(input.message);
    this.statusCode = input.statusCode;
    this.isRetryable = input.isRetryable ?? true;
    this.responseHeaders = input.responseHeaders;
    this.failureClass = input.failureClass;
  }
}

/** The fake reads a fixture verdict; it implements no provider or window rules. */
export function fakeClassifyFailure(facts: FailureFacts): FailureClass {
  const error = facts.error;
  const cause = error instanceof FakeProviderError ? error : isLlmRunFailure(error) ? error.cause : undefined;
  if (cause instanceof FakeProviderError) {
    if (cause.failureClass === undefined) throw new Error("fixture must supply FailureClass");
    return cause.failureClass;
  }
  return { kind: "terminal", reason: "transient_error", providerReason: "non_retryable" };
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
