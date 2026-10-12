import type { APICallError } from "ai";
import { AgentFailure } from "../core/failure";

export { AgentFailure };
import { Data } from "effect";

// Field shapes are compile-time only (#1259 idx 90): plain types, no
// module-load zod schemas — nothing here ever parses. A cause is a string verbatim or the Error itself.
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
  /** The SDK error when the attempt failed at the provider, else the typed failure's own cause or the failure itself. */
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
/** A model-catalog source failed (#1312): cache read/parse, remote fetch/parse, or cache write. */
export class ModelCatalogError extends Data.TaggedError("ModelCatalogError")<
  MessageFields & { readonly source: "cache" | "remote" | "cache_write"; readonly path: string }
> {}
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
