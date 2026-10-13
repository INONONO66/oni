import { APICallError } from "ai";
import { APIError } from "../../../src/model/error";

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

/** Fixed injection sources for `Retry.decide`: pinned clock, zero jitter draw unless overridden. */
export const FIXED_RETRY_NOW = Date.parse("2030-01-01T00:00:00.000Z");
export function sources(
  overrides: Partial<{ now: () => number; random: () => number }> = {},
): { now: () => number; random: () => number } {
  return { now: () => FIXED_RETRY_NOW, random: () => 0, ...overrides };
}
