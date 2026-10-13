import type { BusEvent, Message, Model, PlainObject, Token, Tool } from "@openomni/protocol";
import { Context, Data, type Effect } from "effect";
import { z } from "zod";

/**
 * The model-call port (#1352): the core declares the request, event and
 * failure vocabulary a call layer must speak and the composition root binds
 * the llm workspace to the {@link Llm} tag. Nothing here names an SDK type.
 */

/** The streaming callback contract of one call: the producer side of every durable message. */
export interface LlmSink {
  onMessage: (message: Message.WithParts) => void;
  /** Every onToolResult pairs with a preceding onToolCall; interruptions settle as error results. */
  onToolCall: (call: Tool.Call) => void;
  onToolResult: (result: Tool.Result) => void;
}

/** A catalog-resolved model: the protocol reference plus the facts the loop reads (window, provider identity). */
export interface ResolvedModel {
  readonly id: string;
  readonly providerID: string;
  readonly api?: {
    readonly id?: string | undefined;
    readonly url?: string | undefined;
    readonly npm: string;
  } | undefined;
  readonly name: string;
  readonly family?: string | undefined;
  readonly limit?: { readonly context: number } | undefined;
}

/** An explicit credential the host hands down for one call. */
export type LlmCredential =
  | { readonly type: "api"; readonly key: string }
  | { readonly type: "proxy"; readonly baseURL: string; readonly apiKey?: string | undefined };

/** Operator-supplied endpoint and headers for one call; absent keeps the catalog's URL. */
export interface LlmTransport {
  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;
}

/** One call's request value. The loop builds it; the call layer never reads an environment of its own. */
export interface RunInput {
  messages: Message.WithParts[];
  tools: Tool.Spec[];
  system?: string;
  signal?: AbortSignal;
  model: ResolvedModel;
  auth?: LlmCredential;
  /** Provider to which the explicit credential belongs; absent binds it to model. */
  authProvider?: string;
  transport?: LlmTransport;
  allowAuthFallback?: boolean;
  toolChoice?: "auto" | "required" | "none";
  /** Maximum generated tokens for this call; absent leaves the provider default. */
  maxTokens?: number;
  /** Call-owned sampling temperature; absent leaves the provider default. */
  temperature?: number;
  /** Stop at the step boundary once the last step's cache-inclusive input tokens reach this; absent = never. */
  yieldAtInputTokens?: number;
  /** Stop at the next step boundary while this returns true. */
  shouldYield?: () => boolean;
  /** Provider namespaces forwarded verbatim; the shape is the provider's, the values are JSON. */
  providerOptions?: PlainObject;
  now: () => number;
  id: () => string;
  /** The run this call belongs to: a round trip that cannot name its run and session correlates to nothing. */
  trace: { traceId: string; sessionId: string; runId: string };
  /** Where observation goes; the call layer reports what it did without a process-wide singleton. */
  events: BusEvent.Sink;
}

/** Billed counts of one attempt; every field is authoritative, including zero. */
export type AttemptUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

export type UsageProvenance = "reported" | "estimated" | "unknown";

/** A failed call as the loop sees it; provider facts stay behind {@link LlmPort.classifyFailure}. Identified by `_tag`, never by class. */
export class LlmRunFailure extends Data.TaggedError("LlmRunFailure")<{
  readonly message: string;
  /** The implementation's own error (the provider SDK error when the attempt failed at the provider) or a string. */
  readonly cause?: Error | string | undefined;
  /** The provider SDK error's name when `cause` is one; a transport or typed failure keeps it absent. */
  readonly providerErrorName?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly usageProvenance?: UsageProvenance | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly usage: AttemptUsage;
  readonly aborted: boolean;
  readonly contextOverflow: boolean;
  readonly visibleOutput: boolean;
}> {}

const LlmRunFailureTag = z.object({ _tag: z.literal("LlmRunFailure") });

/** Structural identity, never a class check: the implementation's class lives behind the port. */
export function isLlmRunFailure<E>(error: E): error is E & LlmRunFailure {
  return LlmRunFailureTag.safeParse(error).success;
}

/** Any other typed refusal the port raises (resolution, credentials, catalog); the loop keeps only its text. */
export interface LlmFailure {
  readonly _tag: string;
  readonly message: string;
}

/** Billed usage, the visible-output boundary and the credential handle of one provider attempt. */
export interface AttemptEvidence {
  readonly usage: AttemptUsage;
  readonly usageProvenance?: UsageProvenance | undefined;
  readonly visibleOutput: boolean;
  readonly finishReason: string;
  readonly credential: { readonly type: LlmCredential["type"]; readonly fingerprint: string } | null;
}

export type RunResult =
  | { readonly type: "stop"; readonly evidence?: AttemptEvidence | undefined }
  | { readonly type: "continue" }
  | { readonly type: "aborted"; readonly error?: LlmRunFailure | undefined }
  | { readonly type: "error"; readonly error: LlmRunFailure };

/** What the loop knows about a settled attempt; the port reads provider facts out of `error` itself. */
export interface FailureFacts {
  readonly error?: Error;
  readonly usage?: Token.ProviderUsage | undefined;
  readonly finishReason?: string | undefined;
  readonly contextWindow?: number | undefined;
  /** The wall-clock instant the facts were gathered, so a timestamp-relative provider wait is a fact, not a clock read. */
  readonly now?: number | undefined;
}

/** The provider-side vocabulary the retry telemetry publishes; consumers branch on it, never on prose. */
export type ProviderReason =
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "validation_error"
  | "billing"
  | "content_policy"
  | "non_retryable";
export type RetryableProviderReason = Exclude<ProviderReason, "non_retryable" | "billing" | "content_policy">;

/** The recorded attempt reason a classified call failure maps to; the overflow kind records `context_overflow`. */
type AttemptFailureReason = "timeout" | "transient_error" | "validation_error";

/**
 * The closed classification the loop decides on. `instant` marks a retryable
 * failure the transport answered without HTTP evidence; `afterMs` is the
 * provider-named wait and `directed` whether it was explicit, not inferred.
 */
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

/** One attempt per invocation; retry admission, caps and delays belong to the loop. */
export interface LlmPort {
  /** Resolve a protocol reference against the catalog; `now` drives proxy-listing freshness. */
  readonly resolveModel: (ref: Model.Ref, now: () => number) => Effect.Effect<ResolvedModel, LlmFailure>;
  readonly run: (input: RunInput, sink: LlmSink) => Effect.Effect<RunResult, LlmFailure>;
  /** Pure: the same facts always classify the same way. */
  readonly classifyFailure: (facts: FailureFacts) => FailureClass;
}

/** The Context tag the composition root binds; the key predates the port. */
export class Llm extends Context.Service<Llm, LlmPort>()("@openomni/agent/Llm") {}

/** Add billed usage, including failed attempts; auxiliary counts are not billed twice. */
export function accumulateUsage(total: Token.AgentUsage, usage: Token.ProviderUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.totalTokens += usage.inputTokens + usage.outputTokens;
  for (const key of ["reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    const count = usage[key] ?? 0;
    if (count > 0) total[key] = (total[key] ?? 0) + count;
  }
}
