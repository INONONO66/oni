import type { BusEvent, Message, PlainObject, Tool } from "@oni/protocol";
import { LlmCall, type Transcript } from "@oni/protocol";
import { Effect } from "effect";
import { streamText } from "ai";
import { LlmRunFailure, InvalidProviderData, type LlmError } from "./errors";
import type { Sink } from "./sink";
import { Processor } from "./processor";
import { toModelMessages } from "./message";
import type { Provider } from "./provider";
import { ProviderTransform } from "./provider/transform";
import { getLanguage, type Transport } from "./provider/sdk";
import { Auth } from "./auth/storage";
import { coerceApiError, decodeLlmFailure, errorFacts } from "./error";
import { adaptStream, streamArguments } from "./provider/stream";
import { isContextOverflow, retryAfterMs as providerRetryAfterMs } from "./classify";
import type { RoutingFacts } from "./router/decide";
import type { StreamEvent } from "./processor/event-schema";

export interface RunInput {
  /** An explicit turn identity keeps affinity across continuation calls. */
  routing?: { readonly category?: string; readonly turn?: string };
  messages: Message.WithParts[];
  tools: Tool.Spec[];
  system?: string;
  signal?: AbortSignal;
  model: Provider.Model;
  auth?: Auth.Info;
  /** Absent binds the explicit credential to the model. */
  authProvider?: string;
  /** Resolved by the host and handed down like `auth`, so this package reads no environment. */
  transport?: Transport;
  allowAuthFallback?: boolean;
  toolChoice?: "auto" | "required" | "none";
  maxTokens?: number;
  /** Call-owned sampling temperature; absent leaves the provider default. */
  temperature?: number;
  /**
   * Stops the step loop gracefully once the last finished step's cache-inclusive input tokens reach
   * this, so the caller compacts at a deterministic seam.
   */
  yieldAtInputTokens?: number;
  /** Stops the step loop at the next boundary while this host check is true (injection pending). */
  shouldYield?: () => boolean;
  /** The shape is the provider's; forwarded verbatim. */
  providerOptions?: PlainObject;
  /** Required: the host injects it so identical runs are reproducible. */
  now: () => number;
  /** Required for the same reason as `now`. */
  id: () => string;
  /**
   * Not defaulted: a round trip that cannot name its run and session yields a detached assistant
   * message and telemetry correlating to nothing.
   */
  trace: { traceId: string; sessionId: string; runId: string };
  /** Reports what the call did without a process-wide singleton. */
  events: BusEvent.Sink;
}

interface RunDependencies {
  /** For an isolated caller or test harness. */
  createStream?: Processor.ProcessorOptions["createStream"];
  /** The router observes deltas before the processor buffers them. */
  observeStream?: (stream: AsyncIterable<StreamEvent>) => AsyncIterable<StreamEvent>;
}

/** `run()` is the sole producer of this outcome vocabulary. */
export namespace Run {
  export type Failure = LlmRunFailure;

  export interface AttemptEvidence {
    readonly usage: LlmRunFailure["usage"];
    readonly usageProvenance?: LlmRunFailure["usageProvenance"];
    readonly visibleOutput: boolean;
    readonly finishReason: string;
    readonly credential: ReturnType<typeof Auth.reference> | null;
  }

  export type Outcome = (
    | { readonly type: "stop"; readonly evidence?: AttemptEvidence }
    | { readonly type: "continue" }
    | { readonly type: "aborted"; readonly error?: Failure }
    | { readonly type: "error"; readonly error: Failure }
  ) & { readonly routing?: RoutingFacts; readonly billedUsage?: AttemptEvidence["usage"] };
}

function assignWireToolNames(tools: Tool.Spec[]): {
  wireNames: string[];
  originalByWire: Map<string, string>;
} | InvalidProviderData {
  const wireNames: string[] = [];
  const originalByWire = new Map<string, string>();
  for (const spec of tools) {
    const wire = ProviderTransform.sanitizeToolName(spec.name);
    if (wire.length === 0 || originalByWire.has(wire))
      return new InvalidProviderData({
        operation: "run.tools",
        cause: `ambiguous provider tool name: ${spec.name}`,
        message: "provider tool names must be distinct after normalization",
      });
    originalByWire.set(wire, spec.name);
    wireNames.push(wire);
  }
  return { wireNames, originalByWire };
}

/**
 * The prompt as one text blob for the local usage estimator: deterministic and proportional to the
 * real prompt, a substitute for missing provider accounting, not a tokenizer.
 */
function serializePrompt(system: string, input: RunInput, model: Provider.Model): string {
  return JSON.stringify({
    system,
    messages: toModelMessages(input.messages, model),
    tools: input.tools.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
    })),
  });
}

function attemptUsage(totals: Transcript.Usage): Run.AttemptEvidence["usage"] {
  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    reasoningTokens: totals.reasoning,
    cacheReadTokens: totals.cache.read,
    cacheWriteTokens: totals.cache.write,
  };
}

export function run(
  input: RunInput & {
    /** Resolved once by the composition root; never read from the environment here. */
    readonly authFilePath: string;
  },
  sink: Sink,
  dependencies: RunDependencies = {},
): Effect.Effect<Run.Outcome, LlmError> {
  return Effect.suspend((): Effect.Effect<Run.Outcome, LlmError> => {
  const { messages, system = "", signal, model } = input;

  const controller = new AbortController();
  const abortSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  if (abortSignal.aborted) {
    return Effect.succeed({ type: "aborted" } as const);
  }

  const { traceId, runId } = input.trace;
  const sessionID = input.trace.sessionId;
  if (traceId.length === 0 || sessionID.length === 0 || runId.length === 0) {
    return new InvalidProviderData({ operation: "run.trace", cause: "empty trace identity", message: "llm run requires a non-empty traceId, sessionId, and runId" });
  }
  const messageID = `msg-${input.id()}`;
  const parentID = messages[messages.length - 1]?.info.id || "";

  // Wire names and history share the sanitizer; invocation identity stays dotted.
  const names = assignWireToolNames(input.tools);
  if (names instanceof InvalidProviderData) return names;
  const { wireNames, originalByWire } = names;

  const assistantMessage: Message.AssistantMessage = {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: input.now() },
    parentID,
    modelID: model.id,
    providerID: model.providerID,
    agent: "default",
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };

  let credential: ReturnType<typeof Auth.reference> | undefined;
  const createStream: Processor.ProcessorOptions["createStream"] = (streamInput) => Effect.gen(function* () {
    const auth = yield* Auth.resolve(
      model.providerID,
      input.authFilePath,
      input.auth,
      input.authProvider,
      input.allowAuthFallback,
    );
    credential = Auth.reference(auth);

    const streamResult = yield* Effect.try({
      try: () => streamText(streamArguments(input, streamInput.system, abortSignal, wireNames, getLanguage(model, auth, input.transport))),
      catch: decodeLlmFailure("provider.stream"),
    });
    return { fullStream: adaptStream(streamResult.fullStream) };
  });
  const provider = model.providerID;
  const modelId = model.id;

  const processor = Processor.create({
    // Call-local injection keeps harnesses isolated from Bun's process-wide module mocks.
    createStream: (request) => (dependencies.createStream ?? createStream)(request).pipe(
      Effect.map((stream) => ({
        fullStream: dependencies.observeStream?.(stream.fullStream) ?? stream.fullStream,
      })),
    ),
    events: input.events,
    assistantMessage,
    sessionID,
    model,
    abort: abortSignal,
    now: input.now,
    id: input.id,
    sink,
    toolNames: originalByWire,
    externalTools: true,
    trace: {
      traceId,
      sessionId: sessionID,
      runId: input.trace.runId,
      provider,
    },
  });

  input.events.publish(LlmCall.Events.Started, {
    traceId,
    sessionId: sessionID,
    runId: input.trace.runId,
    provider,
    model: modelId,
    messageCount: messages.length,
    toolCount: input.tools.length,
    time: input.now(),
  });

  const startMs = input.now();

  return processor.process({ system, promptText: serializePrompt(system, input, model) }).pipe(Effect.match({
    onSuccess: (): Run.Outcome => {
    const durationMs = input.now() - startMs;
    // Usage belongs to this single provider attempt.
    const finalTokens = processor.usageTotals;
    const finishReason = processor.message.finish ?? "unknown";

    input.events.publish(LlmCall.Events.Completed, {
      traceId,
      sessionId: sessionID,
      runId: input.trace.runId,
      provider,
      model: modelId,
      durationMs,
      inputTokens: finalTokens.input,
      outputTokens: finalTokens.output,
      reasoningTokens: finalTokens.reasoning,
      cacheReadTokens: finalTokens.cache.read,
      cacheWriteTokens: finalTokens.cache.write,
      finishReason,
      time: input.now(),
    });

    // A completed stream that closed as content-filter or error and showed
    // nothing is a failed attempt, not an answer (#1500): judged as a stop,
    // the loop replays the prompt the provider refuses until exact_repeat.
    // A refusal that already showed text stays a stop, like the overflow rule.
    if (finishReason === "error" && !processor.visibleOutput) {
      const closedAs = processor.finishReason ?? "error";
      return {
        type: "error",
        error: new LlmRunFailure({
          message: `provider closed the stream as ${closedAs} with no output`,
          provider, model: modelId,
          usage: attemptUsage(finalTokens),
          usageProvenance: processor.usageProvenance,
          aborted: false,
          contextOverflow: false,
          contentFiltered: closedAs === "content-filter" || closedAs === "content_filter",
          visibleOutput: false,
        }),
      };
    }

    return {
      type: "stop",
      evidence: {
        usage: attemptUsage(finalTokens),
        usageProvenance: processor.usageProvenance,
        visibleOutput: processor.visibleOutput,
        finishReason,
        credential: credential ?? null,
      },
    };
  }, onFailure: (err): Run.Outcome => {
    const apiError = coerceApiError(err);
    const source = apiError ?? err;
    const sourceFacts = errorFacts(source);
    const aborted = abortSignal.aborted || sourceFacts.aborted === true;
    const retryAfterMs = providerRetryAfterMs(source, input.now);
    const failure = new LlmRunFailure({
        message: err.message === "" ? err._tag : err.message,
        provider, model: modelId,
        providerErrorName: apiError?.name,
        retryAfterMs,
        usage: attemptUsage(processor.usageTotals),
        usageProvenance: processor.usageProvenance,
        aborted,
        contextOverflow: sourceFacts.contextOverflow ?? isContextOverflow(err),
        visibleOutput: processor.visibleOutput,
        // The SDK error itself is the provider-fact carrier for classification.
        cause: apiError ?? err.cause ?? err,
    });
    if (err.stack !== undefined) failure.stack = err.stack;

    input.events.publish(LlmCall.Events.Failed, {
      traceId,
      sessionId: sessionID,
      runId: input.trace.runId,
      provider,
      model: modelId,
      durationMs: input.now() - startMs,
      error: err.message,
      aborted,
      time: input.now(),
    });

    if (aborted) {
      return { type: "aborted", error: failure };
    }

    return { type: "error", error: failure };
  }}), Effect.onInterrupt(() => Effect.sync(() => controller.abort())));
  });
}
