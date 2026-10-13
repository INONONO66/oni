import { APICallError } from "ai";
import { classifyFailure } from "../../src/classify";
import { APIError } from "../../src/error";
import type { FailureClass, ProviderReason } from "../../src/port";

export type SdkErrorInput = {
  readonly message: string;
  readonly isRetryable?: boolean;
  readonly statusCode?: number;
  readonly responseHeaders?: Record<string, string>;
  readonly responseBody?: string;
};

export function sdkError(input: SdkErrorInput): APICallError {
  return new APICallError({
    url: "https://provider.test/v1/messages",
    requestBodyValues: {},
    ...input,
  });
}

export const apiError = (input: SdkErrorInput) => new APIError({ cause: sdkError(input) });

export function rateLimitError(headers?: Record<string, string>) {
  return apiError({
    message: "rate limited",
    isRetryable: true,
    statusCode: 429,
    ...(headers && { responseHeaders: headers }),
  });
}

/** The pinned clock header-relative waits are measured against. */
export const FIXED_RETRY_NOW = Date.parse("2030-01-01T00:00:00.000Z");

/** Classify one error at the pinned clock. */
export function classifyError<E>(error: E, now = FIXED_RETRY_NOW): FailureClass {
  return classifyFailure({ error, now });
}

/** The provider reason of a classified call failure; abort and overflow carry none. */
export function providerReasonOf<E>(error: E): ProviderReason | "aborted" | "overflow" {
  const classified = classifyError(error);
  return classified.kind === "retryable" || classified.kind === "terminal" ? classified.providerReason : classified.kind;
}
