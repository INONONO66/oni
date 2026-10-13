import { Core } from "@openomni/agent";
const ObservationSink = Core.ObservationSink;
type ObservationSink = Core.ObservationSink;
const executorContext = Core.executorContext;
const AgentFailure = Core.AgentFailure;
const Interrupted = Core.Interrupted;
type ExecutionError = Core.ExecutionError;
const Llm = Core.Llm;
type Llm = Core.Llm;
type RunInput = Core.RunInput;
type Sink = Core.LlmSink;
import { traceIdFromUuid, type Message, type PlainObject } from "@openomni/protocol";
import { Effect } from "effect";
import type { LlmCall } from "../tools/completion";

interface ResolvedModel {
  readonly provider: string;
  readonly id: string;
  readonly apiKey: string;
  readonly transport?: { readonly baseUrl?: string; readonly headers?: Record<string, string> };
}
interface ResolvedTextCall {
  readonly model: ResolvedModel;
  /** Injected clock + id entropy (#1245): timestamps, trace and run identifiers — no ambient Date/crypto. */
  readonly now: () => number;
  readonly id: () => string;
  readonly messages: Message.WithParts[];
  readonly system?: string;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly maxTokens?: number;
  readonly providerOptions?: PlainObject;
}

function textCapture(): { readonly sink: Sink; readonly text: () => string } {
  let answer = "";
  return {
    sink: {
      onMessage: (message) => {
        if (message.info.role === "assistant")
          answer = message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
      },
      onToolCall: () => undefined,
      onToolResult: () => undefined,
    },
    text: () => answer,
  };
}

function textOutcome(outcome: Core.RunResult, text: string): Effect.Effect<{ readonly text: string }, ExecutionError> {
  if (outcome.type === "stop") return Effect.succeed({ text });
  if (outcome.type === "error") return Effect.fail(outcome.error);
  if (outcome.type === "aborted") return Effect.fail(new Interrupted());
  return Effect.fail(new AgentFailure({ operation: "completion", cause: "sub-model returned continue" }));
}

/** The app composes the native attempt; only the tool adapter at the gateway runs it. */
export function runResolvedText(call: ResolvedTextCall): Effect.Effect<string, ExecutionError, Llm | ObservationSink> {
  return Effect.gen(function* () {
    const capture = textCapture();
    const llm = yield* Llm;
    const events = yield* ObservationSink;
    const resolved = yield* llm.resolveModel({ provider: call.model.provider, id: call.model.id }, call.now)
      .pipe(Effect.mapError((error) => new AgentFailure({ operation: "completion.resolve", cause: String(error) })));
    const input: RunInput = {
      messages: call.messages, tools: [], toolChoice: "none", model: resolved,
      auth: { type: "api", key: call.model.apiKey }, authProvider: call.model.provider,
      ...(call.system === undefined ? {} : { system: call.system }),
      ...(call.model.transport === undefined ? {} : { transport: call.model.transport }),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
      ...(call.maxTokens === undefined ? {} : { maxTokens: call.maxTokens }),
      ...(call.providerOptions === undefined ? {} : { providerOptions: call.providerOptions }),
      now: call.now, id: call.id,
      trace: { traceId: traceIdFromUuid(call.id()), sessionId: call.sessionId, runId: call.id() }, events,
    };
    const executor = yield* executorContext;
    const runAttempts = executor.runAttempts;
    if (runAttempts === undefined)
      return yield* new AgentFailure({ operation: "completion", cause: "sub-model requires session attempt authority" });
    const intent = { provider: resolved.providerID, model: resolved.id };
    const result = yield* executor.run({ kind: "llm", op: "text", intent, effect: {} }, (parent) => runAttempts(parent, {
      // The sub-model call reads its failures through the same port the loop does (#1352).
      classify: (failure) => llm.classifyFailure({
        error: failure, now: call.now(),
        ...(Core.isLlmRunFailure(failure) ? { usage: failure.usage } : {}),
        ...(resolved.limit?.context === undefined ? {} : { contextWindow: resolved.limit.context }),
      }),
      prepare: (attempt) => Effect.succeed({
        request: { op: "text", intent: { attempt, ...intent }, effect: {} },
        admit: () => call.signal?.aborted ? Effect.fail(new Interrupted()) : Effect.void,
        body: () => llm.run(input, capture.sink).pipe(
          Effect.mapError((error): ExecutionError => Core.isLlmRunFailure(error) ? error : new AgentFailure({ operation: "completion.run", cause: error.message })),
          Effect.flatMap((outcome) => textOutcome(outcome, capture.text())),
        ),
      }),
    }));
    if (result.terminal === "interrupted") return yield* new Interrupted();
    if (result.terminal !== "executed")
      return yield* new AgentFailure({ operation: "completion", cause: `sub-model refused: ${result.reason}` });
    const value = result.value;
    if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string")
      return yield* new AgentFailure({ operation: "completion", cause: "invalid sub-model result" });
    return value.text;
  });
}

export function createCompletionPort(
  model: ResolvedModel,
  sources: { readonly now: () => number; readonly id: () => string },
) {
  return (call: LlmCall): Effect.Effect<string, ExecutionError, Llm | ObservationSink> => {
    const sessionId = "completion";
    const messageId = sources.id();
    const target = call.model === undefined ? model : { ...model, id: call.model };
    return runResolvedText({
      model: target,
      now: sources.now,
      id: sources.id,
      messages: [{
        info: { id: messageId, sessionID: sessionId, role: "user", time: { created: sources.now() }, agent: "completion", model: { providerID: target.provider, modelID: target.id } },
        parts: [{ id: sources.id(), sessionID: sessionId, messageID: messageId, type: "text", text: call.prompt }],
      }],
      sessionId,
      ...(call.system === undefined ? {} : { system: call.system }),
    });
  };
}
