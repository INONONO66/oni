import { Core } from "@openomni/agent";
const LlmRunFailure = Core.LlmRunFailure;
import { APICallError } from "ai";

export function providerFailure(
  message: string,
  cause: Error = new APICallError({
    message,
    url: "https://provider.test/v1/messages",
    requestBodyValues: {},
    statusCode: 529,
    responseHeaders: { "retry-after-ms": "0" },
    isRetryable: true,
  }),
): Core.LlmRunFailure {
  return new LlmRunFailure({
      message,
      aborted: cause.name === "AbortError",
      contextOverflow: false,
      visibleOutput: false,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      cause: APICallError.isInstance(cause) ? cause : String(cause),
      ...(APICallError.isInstance(cause) ? { providerErrorName: cause.name } : {}),
      retryAfterMs: 0,
  });
}
