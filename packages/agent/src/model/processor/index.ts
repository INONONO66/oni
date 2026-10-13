import { Effect } from "effect";
import { decodeLlmFailure, errorFacts, failureText } from "../error";
import type { LlmError } from "../errors";
import { drainToolSettlements } from "./tool-events";
import {
  Operational,
  Transcript,
  type BusEvent,
  type Message,
  type PlainObject,
  type Tool,
  toolResultText,
} from "@openomni/protocol";
import type { Sink } from "../sink";
import type { Provider } from "../provider";
import { estimateUsage as defaultEstimateUsage, type EstimateUsage } from "../token";
import {
  createStreamEventState,
  handleStreamEvent,
  mapFinishReason,
  settleAttempt,
  type StreamEvent,
  type StreamEventContext,
  type StreamEventState,
} from "./stream-events.js";

/** A rejected transcript fold is a programmer defect in this package, never a provider fault. */
class TranscriptRecordingDefect extends Error {
  constructor(reason: string, factType: string) {
    super(`transcript recording defect: ${reason} on ${factType}`);
    this.name = "TranscriptRecordingDefect";
  }
}

export namespace Processor {
  const STREAM_CLOSE_GRACE_MS = 250;

  interface StreamInput {
    system: string;
    /** Exact serialized prompt, used only for missing provider usage. */
    promptText: string;
  }
  interface Stream {
    fullStream: AsyncIterable<StreamEvent>;
  }

  export interface ProcessorOptions {
    assistantMessage: Message.AssistantMessage;
    sessionID: string;
    model: Provider.Model;
    abort: AbortSignal;
    externalTools?: boolean;
    estimateUsage?: EstimateUsage;
    sink?: Sink;
    events: BusEvent.Sink;
    now: () => number;
    id: () => string;
    createStream: (input: StreamInput) => Effect.Effect<Stream, LlmError>;
    toolNames?: ReadonlyMap<string, string>;
    trace: { traceId: string; sessionId: string; runId?: string; provider?: string };
  }

  interface ProcessorInfo {
    message: Message.AssistantMessage;
    usageTotals: Transcript.Usage;
    usageProvenance: StreamEventState["usageProvenance"];
    visibleOutput: boolean;
    process(streamInput: StreamInput): Effect.Effect<void, LlmError>;
  }

  /** One provider attempt, one immutable transcript fold. Retry is executor control flow. */
  export function create(options: ProcessorOptions): ProcessorInfo {
    const {
      assistantMessage,
      sessionID,
      abort,
      events,
      now,
      id,
      createStream,
      toolNames,
      estimateUsage = defaultEstimateUsage,
      trace,
    } = options;
    const sink = createProjectedSink(
      events,
      options.sink ?? createNoopSink(),
      sessionID,
      trace.traceId,
      now,
    );
    let folded: Message.WithParts | undefined;
    const eventState = createStreamEventState();
    const attemptId = `${assistantMessage.id}#1`;

    function record(fact: Transcript.Fact): void {
      const outcome = Transcript.fold(folded, fact);
      if ("rejected" in outcome) throw new TranscriptRecordingDefect(outcome.reason, fact.type);
      folded = outcome.state;
      if (fact.type !== "message.created") sink.onMessage(folded);
    }

    function closeStream(iterator: AsyncIterator<StreamEvent>): Effect.Effect<void> {
      return Effect.tryPromise({
        try: () => iterator.return?.() ?? Promise.resolve({ done: true as const, value: undefined }),
        catch: decodeLlmFailure("stream.close"),
      }).pipe(
        Effect.timeoutOption(STREAM_CLOSE_GRACE_MS),
        Effect.catch((error) => Effect.sync(() => publishInfo(events, sessionID, trace.traceId, now, "stream.close.failed", { error: failureText(error) }))),
        Effect.asVoid,
        Effect.interruptible,
      );
    }

    function process(streamInput: StreamInput): Effect.Effect<void, LlmError> {
      return Effect.suspend(() => {
      publishStatus(events, sessionID, trace.traceId, now, "busy");
      record({ type: "message.created", attemptId, message: { ...assistantMessage } });
      const eventContext: StreamEventContext = {
        sessionID,
        messageID: assistantMessage.id,
        attemptId,
        sink,
        record,
        note: (msg, data) => publishInfo(events, sessionID, trace.traceId, now, msg, data),
        now,
        id,
        promptText: streamInput.promptText,
        estimateUsage,
        externalTools: options.externalTools,
        ...(toolNames === undefined ? {} : { toolNames }),
      };
      function finish(finish: Transcript.FinishReason): void {
        record({
          type: "message.finished",
          attemptId,
          messageId: assistantMessage.id,
          at: now(),
          finish,
          usage: eventState.usage,
        });
      }
      return Effect.gen(function* () {
        yield* Effect.try({ try: () => abort.throwIfAborted(), catch: decodeLlmFailure("stream.abort") });
        const stream = yield* createStream(streamInput);
        const iterator = stream.fullStream[Symbol.asyncIterator]();
        yield* Effect.gen(function* () {
          for (;;) {
            const next = yield* Effect.tryPromise({ try: () => iterator.next(), catch: decodeLlmFailure("stream.next") });
            if (next.done) break;
            if (abort.aborted) {
              yield* drainToolSettlements(iterator, next.value, eventState, eventContext);
              yield* Effect.try({ try: () => abort.throwIfAborted(), catch: decodeLlmFailure("stream.abort") });
            }
            yield* Effect.try({ try: () => handleStreamEvent(next.value, eventState, eventContext), catch: decodeLlmFailure("stream.event") });
          }
        }).pipe(Effect.ensuring(closeStream(iterator)));
        settleAttempt(eventState, eventContext, { aborted: false, preserveTools: options.externalTools });
        finish(mapFinishReason(eventState.finishReason));
      }).pipe(
        Effect.tapError((error) => Effect.sync(() => {
          const aborted = abort.aborted || errorFacts(error).aborted === true;
          settleAttempt(eventState, eventContext, { aborted });
          finish(aborted ? "aborted" : "error");
        })),
        Effect.onInterrupt(() => Effect.sync(() => {
          settleAttempt(eventState, eventContext, { aborted: true });
          finish("aborted");
        })),
        Effect.ensuring(Effect.sync(() => publishStatus(events, sessionID, trace.traceId, now, "idle"))),
      );
      });
    }
    return {
      get message() {
        return (folded?.info ?? assistantMessage) as Message.AssistantMessage;
      },
      get usageTotals() {
        return { ...eventState.usage, cache: { ...eventState.usage.cache } };
      },
      get usageProvenance() {
        return eventState.usageProvenance;
      },
      get visibleOutput() {
        return eventState.visibleOutput;
      },
      process,
    };
  }

  function publishInfo(
    events: BusEvent.Sink,
    sessionID: string,
    traceId: string,
    now: () => number,
    message: string,
    data?: PlainObject,
  ): void {
    events.publish(Operational.Events.Info, {
      traceId,
      time: now(),
      sessionId: sessionID,
      component: "llm.processor",
      msg: message,
      context: data,
    });
  }

  function createProjectedSink(
    events: BusEvent.Sink,
    sink: Sink,
    sessionID: string,
    traceId: string,
    now: () => number,
  ): Sink {
    return {
      onMessage(message) {
        sink.onMessage(message);
        publishInfo(events, sessionID, traceId, now, "sink.message", {
          role: message.info.role,
          messageId: message.info.id,
          partCount: message.parts.length,
        });
      },
      onToolCall(call: Tool.Call) {
        sink.onToolCall(call);
        publishInfo(events, sessionID, traceId, now, "sink.tool.started", {
          toolCallId: call.id,
          toolName: call.tool,
          inputSummary: summarizeRecord(call.input),
        });
      },
      onToolResult(result: Tool.Result) {
        sink.onToolResult(result);
        publishInfo(events, sessionID, traceId, now, "sink.tool.completed", {
          toolCallId: result.toolCallId,
          outputLength: toolResultText(result).length,
          isError: result.isError === true,
        });
      },
    };
  }
  function createNoopSink(): Sink {
    return {
      onMessage: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
    };
  }
  function publishStatus(
    events: BusEvent.Sink,
    sessionID: string,
    traceId: string,
    now: () => number,
    stateType: "busy" | "idle",
  ): void {
    publishInfo(events, sessionID, traceId, now, "sink.snapshot", { stateType });
  }
  function summarizeRecord(input: PlainObject): string {
    const keys = Object.keys(input).sort();
    return keys.length === 0 ? "empty" : keys.join(",");
  }
}
