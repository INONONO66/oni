import type { APICallError } from "ai";
import { Data } from "effect";

/** A cause as one diagnostic line: strings verbatim, an Error as `Name: message` (name or message alone when the other is empty). */
function renderBodyCause(cause: string | Error): string {
  if (typeof cause === "string") return cause;
  if (cause.message === "") return cause.name;
  return cause.name === "" ? cause.message : `${cause.name}: ${cause.message}`;
}

/** A thrown value as an Error (a non-Error wraps its own `String()` text); `instanceof`/`String()` may throw again (a revoked Proxy), so the fallback names only the `typeof` and runs no user code. */
function thrownAsError<T>(cause: T): Error {
  try {
    return cause instanceof Error ? cause : new Error(String(cause));
  } catch {
    return new Error(`sink threw an unrepresentable ${typeof cause}`);
  }
}

/** A non-Error throw at a call-layer boundary, named by the operation that caught it. */
export class LlmOperationFailure extends Data.TaggedError("LlmOperationFailure")<{
  readonly operation: string;
  readonly cause: string | Error;
}> {
  override get message(): string { return `${this.operation}: ${renderBodyCause(this.cause)}`; }
}

// Compile-time shapes only, no module-load zod schemas: nothing here parses.
type Diagnostic = { readonly operation: string; readonly cause: string | Error };
type MessageFields = { readonly message: string; readonly cause?: string | Error };
type ProviderIdentity = {
  readonly provider?: string;
  readonly model?: string;
  readonly usageProvenance?: "reported" | "estimated" | "unknown";
};

/**
 * Thin typed identity over the SDK's own `APICallError`: provider facts
 * (status, headers, body, retryability) live on the SDK error under `cause`
 * and are never copied; this adds only the call identity the SDK lacks.
 */
export class APIError extends Data.TaggedError("APIError")<
  ProviderIdentity & { readonly cause: APICallError }
> {
  override get message(): string { return this.cause.message; }
}

type UsageFields = {
  readonly inputTokens: number; readonly outputTokens: number; readonly reasoningTokens: number;
  readonly cacheReadTokens: number; readonly cacheWriteTokens: number;
};
type RunFields = ProviderIdentity & {
  readonly message: string;
  /** The SDK error when the provider failed, else the typed failure's cause or itself. */
  readonly cause?: APICallError | Error | string;
  /** The SDK error's class name when the attempt failed at the provider; absent for transport and local causes. */
  readonly providerErrorName?: string;
  readonly retryAfterMs?: number;
  readonly usage: UsageFields;
  readonly aborted: boolean;
  readonly contextOverflow: boolean;
  /** The provider completed the stream with a content-filter stop and showed nothing (#1500); absent for every other failure. */
  readonly contentFiltered?: boolean;
  readonly visibleOutput: boolean;
};
export class LlmRunFailure extends Data.TaggedError("LlmRunFailure")<RunFields> {}

type ResolutionFields = MessageFields & {
  readonly provider: string; readonly model: string;
  readonly reason: "provider_not_found" | "proxy_listing_failed" | "model_not_found";
};
export class ModelResolutionError extends Data.TaggedError("ModelResolutionError")<ResolutionFields> {}
export class ProviderRowsError extends Data.TaggedError("ProviderRowsError")<
  MessageFields & { readonly path: string; readonly reason: "unreadable" | "invalid_json" | "invalid_rows" | "unsupported_npm" }
> {}
export class AuthInvalidFileError extends Data.TaggedError("AuthInvalidFileError")<MessageFields & { readonly path: string }> {}
export class AuthResolutionError extends Data.TaggedError("AuthResolutionError")<MessageFields & { readonly provider: string; readonly reason: "missing_auth" | "invalid_auth" }> {}
export class ProxyModelsError extends Data.TaggedError("ProxyModelsError")<MessageFields & { readonly url: string; readonly status?: number }> {}
/** Cache read/parse, remote fetch/parse, or cache write. */
export class ModelCatalogError extends Data.TaggedError("ModelCatalogError")<
  MessageFields & { readonly source: "cache" | "remote" | "cache_write"; readonly path: string }
> {
  /** A catalog source throw as the typed refusal: structured cause, rendered-text message. */
  static fromThrown<E>(source: ModelCatalogError["source"], path: string, cause: E): ModelCatalogError {
    const error = thrownAsError(cause);
    return new ModelCatalogError({ source, path, cause: error, message: renderBodyCause(error) });
  }
}
type BoundaryFields = Diagnostic & {
  readonly message: string;
  readonly aborted?: boolean;
  readonly providerErrorName?: string;
  readonly provider?: string;
  readonly model?: string;
};
export class TransportFailure extends Data.TaggedError("TransportFailure")<BoundaryFields> {}
export class InvalidProviderData extends Data.TaggedError("InvalidProviderData")<BoundaryFields> {}

export type LlmError = LlmOperationFailure | APIError | LlmRunFailure | ModelResolutionError |
  AuthInvalidFileError | AuthResolutionError | ModelCatalogError | ProxyModelsError | TransportFailure | InvalidProviderData;
