import type { PlainValue, Token } from "@openomni/protocol";

/**
 * The classification vocabulary this package answers the agent core's
 * `LlmPort.classifyFailure` with (#1352). The core declares the port; this
 * package cannot import it (protocol is its only internal dependency), so the
 * shapes are restated here and checked structurally at the composition root.
 */

/** Provider errors and channel-visible plain values accepted by the pure classifier. */
export type ProviderError = Error | PlainValue;

/** What the loop knows about a settled attempt; provider facts are read out of `error` here, never by the loop. */
export interface FailureFacts {
  readonly error?: ProviderError;
  readonly usage?: Token.ProviderUsage | undefined;
  readonly finishReason?: string | undefined;
  readonly contextWindow?: number | undefined;
  /** The wall-clock instant the facts were gathered; timestamp-relative provider waits are unknown without it. */
  readonly now?: number | undefined;
}

/** The provider-side vocabulary retry telemetry and channel rendering branch on; never prose. */
export type ProviderReason =
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "validation_error"
  | "billing"
  | "content_policy"
  | "non_retryable";
export type RetryableProviderReason = Exclude<ProviderReason, "non_retryable" | "billing" | "content_policy">;

/** The recorded attempt reason of a classified call failure; the overflow kind records `context_overflow` in the loop. */
export type AttemptFailureReason = "timeout" | "transient_error" | "validation_error";

export type FailureClass =
  | { readonly kind: "aborted" }
  | { readonly kind: "overflow" }
  | {
      readonly kind: "retryable";
      readonly reason: AttemptFailureReason;
      readonly providerReason: RetryableProviderReason;
      readonly afterMs?: number | undefined;
      readonly directed?: boolean | undefined;
      readonly instant: boolean;
    }
  | {
      readonly kind: "terminal";
      readonly reason: AttemptFailureReason;
      readonly providerReason: ProviderReason;
      readonly status?: number | undefined;
      readonly detail?: string | undefined;
    };
