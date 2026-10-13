import type { APICallError } from "ai";
import { AgentFailure, renderBodyCause, thrownAsError } from "../core/failure";

export { AgentFailure };
import { Data } from "effect";

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
  readonly retryAfterMs?: number;
  readonly usage: UsageFields;
  readonly aborted: boolean;
  readonly contextOverflow: boolean;
  readonly visibleOutput: boolean;
};
export class LlmRunFailure extends Data.TaggedError("LlmRunFailure")<RunFields> {}

type ResolutionFields = MessageFields & {
  readonly provider: string; readonly model: string;
  readonly reason: "provider_not_found" | "proxy_listing_failed" | "model_not_found";
};
export class ModelResolutionError extends Data.TaggedError("ModelResolutionError")<ResolutionFields> {}
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

export type LlmError = AgentFailure | APIError | LlmRunFailure | ModelResolutionError |
  AuthInvalidFileError | AuthResolutionError | ModelCatalogError | ProxyModelsError | TransportFailure | InvalidProviderData;
