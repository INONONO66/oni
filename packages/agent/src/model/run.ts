import type { BusEvent, Message, PlainObject, Tool } from "@openomni/protocol";
import { LlmCall, type Transcript } from "@openomni/protocol";
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
import { Retry } from "./retry";

/**
 * Input for the run() function.
 *
 * The function resolves auth credentials for the configured model
 * and calls the real provider SDK.
 */
export interface RunInput {
  messages: Message.WithParts[];
  tools: Tool.Spec[];
  system?: string;
  signal?: AbortSignal;
  model: Provider.Model;
  auth?: Auth.Info;
  /** Provider to which the explicit credential belongs; absent binds it to model. */
  authProvider?: string;
  /**
   * Operator-supplied endpoint and headers for this call. Resolved by the
   * host from its own config surface and handed down like `auth`, so this
   * package reads no environment of its own. Absent keeps the catalog's URL
   * and the default client identity.
   */
  transport?: Transport;
  allowAuthFallback?: boolean;
  toolChoice?: "auto" | "required" | "none";
  /** Maximum generated tokens for this call; absent leaves the provider default. */
  maxTokens?: number;
  /** Call-owned sampling temperature; absent leaves the provider default. */
  temperature?: number;
  /**
   * Step-boundary yield: stop the step loop once the last finished step's
   * input tokens (the ai SDK's cache-inclusive prompt total) reach this.
   * The loop ends gracefully at a step boundary — tool pairs complete, the
   * message finishes with the model's own finishReason — so the caller can
   * compact history at its deterministic seam and re-enter. Absent = never.
   */
  yieldAtInputTokens?: number;
  /**
   * Step-boundary steering yield (#751): stop the step loop at the next step
   * boundary while this host-injected check returns true — e.g. a mid-turn
   * injection is pending for the run. Evaluated beside the step cap and the
   * window yield, so the loop still ends gracefully: tool pairs complete and
   * the message finishes with the model's own finishReason. Absent = never.
   */
  shouldYield?: () => boolean;
  /** Provider namespaces forwarded verbatim to the SDK; the shape is the provider's, the values are JSON. */
  providerOptions?: PlainObject;
  /**
   * Wall-clock source for every timestamp this call emits. Required: the
   * host injects it so identical runs are reproducible (#1245).
   */
  now: () => number;
  /**
   * Unique-id source for the assistant message identity. Required for the
   * same reason as `now` (#1245).
   */
  id: () => string;
  /**
   * The run this call belongs to. Required, and not defaulted: a model round
   * trip that cannot name its run and session produces an assistant message
   * detached from the conversation it is part of, and telemetry that
   * correlates to nothing.
   */
  trace: { traceId: string; sessionId: string; runId: string };
  /**
   * Where observation goes. See `Processor.ProcessorOptions.events` — the port exists so
   * `llm` reports what it did without reaching for a process-wide singleton.
   */
  events: BusEvent.Sink;
}

interface RunDependencies {
  /** Overrides provider stream creation for an isolated caller or test harness. */
  createStream?: Processor.ProcessorOptions["createStream"];
}

/**
 * #500 C1: the loop-run result vocabulary, moved here from protocol — this
 * package's `run()` is the sole producer and the consumers (agent core) all
 * depend on llm already. The `Run.Outcome` name is kept: llm hosted no `Run`
 * namespace, so there is no collision (`run` the function and `Run` the
 * namespace are distinct identifiers).
 */
export namespace Run {
  export type Failure = LlmRunFailure;

  /** Billed usage, the visible-output boundary and the credential handle of one provider attempt. */
  export interface AttemptEvidence {
    readonly usage: LlmRunFailure["usage"];
    readonly usageProvenance?: LlmRunFailure["usageProvenance"];
    readonly visibleOutput: boolean;
    readonly finishReason: string;
    readonly credential: ReturnType<typeof Auth.reference> | null;
  }

  export type Outcome =
    | { readonly type: "stop"; readonly evidence?: AttemptEvidence }
    | { readonly type: "continue" }
    | { readonly type: "aborted"; readonly error?: Failure }
    | { readonly type: "error"; readonly error: Failure };
}

/**
 * Assign each tool spec its wire name — the provider-pattern-safe key it takes
 * in the `tools` object crossing to the SDK — and the reverse map back to the
 * internal dotted name.
 *
 * The native catalog (`message.send`, `engagement.open`, …) is collision-free
 * under plain `.`→`_`, but MCP tool names are `${server}.${name}` with
 * arbitrary segments, so two distinct originals can sanitize to the same key.
 * A silent overwrite of one advertised tool by another loses invocation
 * identity, so a taken key is disambiguated with a deterministic
 * `_2`/`_3`/… suffix (truncated to keep the 128-char bound). The reverse map
 * lets the transcript record the dotted internal name instead of the wire name.
 */
function assignWireToolNames(tools: Tool.Spec[]): {
  wireNames: string[];
  originalByWire: Map<string, string>;
} {
  const wireNames: string[] = [];
  const originalByWire = new Map<string, string>();
  for (const spec of tools) {
    const base = ProviderTransform.sanitizeToolName(spec.name);
    let wire = base;
    let suffix = 2;
    while (originalByWire.has(wire)) {
      const tail = `_${suffix++}`;
      wire = base.slice(0, 128 - tail.length) + tail;
    }
    originalByWire.set(wire, spec.name);
    wireNames.push(wire);
  }
  return { wireNames, originalByWire };
}

/**
 * The call's prompt as one text blob, for the local usage estimator (#933).
 * Everything the provider is charged input tokens for: the system message, the
 * model-shaped conversation, and the advertised tool schemas. Serialization
 * shape only has to be deterministic and proportional to the real prompt — the
 * estimate is a substitute for missing provider accounting, not a tokenizer.
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
    /**
     * Credential file location, resolved once by the composition root
     * (#1245): this function never reads the environment for it.
     */
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
  const { wireNames, originalByWire } = assignWireToolNames(input.tools);

  const assistantMessage: Message.AssistantMessage = {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: input.now() },
    parentID,
    modelID: model.id,
    providerID: model.providerID,
    agent: "default",
    path: { cwd: process.cwd(), root: process.cwd() },
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
    // Call-local injection keeps test and embedding harnesses isolated from
    // Bun's process-wide module mocks without changing production behavior.
    createStream: dependencies.createStream ?? createStream,
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
    const retryAfterMs = Retry.retryAfterMs(source, input.now);
    const failure = new LlmRunFailure({
        message: err.message === "" ? err._tag : err.message,
        provider, model: modelId,
        retryAfterMs,
        usage: attemptUsage(processor.usageTotals),
        usageProvenance: processor.usageProvenance,
        aborted,
        contextOverflow: sourceFacts.contextOverflow ?? Retry.isContextOverflow(err),
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
