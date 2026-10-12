import { Effect } from "effect";
import { decodeLlmFailure, failureText } from "../error";
import type { LlmError } from "../errors";
import type { Message, Transcript } from "@openomni/protocol";
import { OutputPayload, ProviderEvent } from "./event-schema";
import { stringifyToolOutput, type SDKToolValue } from "../message";
import type { StreamEvent, StreamEventState, StreamEventContext } from "./stream-events";

function resolveToolName(wireName: string, context: StreamEventContext): string {
  return context.toolNames?.get(wireName) ?? wireName;
}

export function appendPart(part: Message.Part, context: StreamEventContext): void {
  context.record({
    type: "part.appended",
    attemptId: context.attemptId,
    messageId: context.messageID,
    part,
  });
}

export function advancePart(
  partId: string,
  transition: Transcript.PartTransition,
  context: StreamEventContext,
): void {
  context.record({
    type: "part.advanced",
    attemptId: context.attemptId,
    messageId: context.messageID,
    partId,
    transition,
  });
}

export function handleToolCall(
  event: ProviderEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  // ai v6 tool-call chunks carry `input`: the model's arguments, one JSON
  // object, parsed here because this is where provider bytes become a fact.
  const input = event.input ?? {};
  const callID = String(event.toolCallId);
  state.visibleOutput = true;
  // A tool call is billed assistant output too: the model emitted the name and
  // the serialized arguments, so the estimator must see them (#933).
  state.stepEmittedAssistant += `${String(event.toolName)}${JSON.stringify(input)}`;
  const part: Message.ToolPart = {
    id: context.id(),
    sessionID: context.sessionID,
    messageID: context.messageID,
    type: "tool",
    callID,
    tool: resolveToolName(String(event.toolName), context),
    state: { status: "pending", input },
  };
  appendPart(part, context);
  // Paired standalone traces enter running here. A session-owned provider
  // step returns pending data; its receiving executor owns execution timing.
  if (!context.externalTools) advancePart(part.id, { to: "running", at: context.now() }, context);
  state.pendingTools.set(callID, part.id);
  context.sink.onToolCall({ id: callID, tool: part.tool, input });
}

export function handleToolResult(
  event: ProviderEvent,
  state: StreamEventState,
  context: StreamEventContext,
): void {
  const toolCallId = String(event.toolCallId);
  const outputPayload = normalizeOutputPayload(event);
  const isError = event.isError === true || outputPayload.isError;
  const partId = state.pendingTools.get(toolCallId);

  if (partId === undefined) {
    // #532-6: a result for a call that never happened. Synthesize an error
    // part so the anomaly is recorded; no Tool.Call/Tool.Result is emitted
    // because no call exists to correlate with.
    context.note("stream.normalized", {
      anomaly: "tool-result for unknown call",
      toolCallId,
    });
    const synthetic: Message.ToolPart = {
      id: context.id(),
      sessionID: context.sessionID,
      messageID: context.messageID,
      type: "tool",
      callID: toolCallId,
      tool:
        event.toolName !== undefined ? resolveToolName(String(event.toolName), context) : "unknown",
      state: { status: "pending", input: {} },
    };
    const at = context.now();
    appendPart(synthetic, context);
    advancePart(synthetic.id, { to: "running", at }, context);
    advancePart(
      synthetic.id,
      { to: "error", at, error: `tool result for unknown call: ${outputPayload.output}` },
      context,
    );
    return;
  }

  state.pendingTools.delete(toolCallId);
  if (context.externalTools) advancePart(partId, { to: "running", at: context.now() }, context);
  advancePart(
    partId,
    isError
      ? { to: "error", at: context.now(), error: outputPayload.output }
      : {
          to: "completed",
          at: context.now(),
          output: outputPayload.output,
          ...(event.toolName !== undefined
            ? { title: resolveToolName(String(event.toolName), context) }
            : {}),
        },
    context,
  );
  context.sink.onToolResult({
    id: context.id(),
    toolCallId,
    content: outputPayload.output,
    ...(isError && { isError: true }),
  });
}

function normalizeOutputPayload(event: ProviderEvent): { output: string; isError: boolean } {
  const raw: SDKToolValue | undefined = event.output;
  if (typeof raw === "object" && raw !== null && "output" in raw) {
    const payload = OutputPayload.parse(raw);
    return {
      output: String(payload.output ?? ""),
      isError: payload.isError === true,
    };
  }
  const value = raw ?? event.error ?? event.message ?? "";
  return {
    output: stringifyToolOutput(value),
    isError: false,
  };
}

/**
 * #532 candidate 2: when a run aborts, results for tools the SDK already
 * executed may still be sitting in the stream. Recording those tools as
 * interrupted would misreport a real side effect, so before the abort is
 * surfaced the processor drains tool settlement events (only) for a bounded
 * grace window. Stops early once every pending tool is settled; never blocks
 * longer than the grace on a dead stream.
 */
const ABORT_SETTLE_GRACE_MS = 250;

export function drainToolSettlements(
  iterator: AsyncIterator<StreamEvent>,
  firstEvent: StreamEvent,
  state: StreamEventState,
  context: StreamEventContext,
): Effect.Effect<void, LlmError> {
  return Effect.gen(function* () {
    let event = firstEvent;
    while (state.pendingTools.size > 0) {
      if (event.type === "tool-result" || event.type === "tool-error") {
        yield* Effect.try({ try: () => handleToolResult(ProviderEvent.parse(event), state, context), catch: decodeLlmFailure("stream.settlement") });
        if (state.pendingTools.size === 0) return;
      }
      const next = yield* Effect.tryPromise({ try: () => iterator.next(), catch: decodeLlmFailure("stream.settlement.next") });
      if (next.done) return;
      event = next.value;
    }
  }).pipe(Effect.timeoutOption(ABORT_SETTLE_GRACE_MS), Effect.catch((error) => Effect.sync(() => {
    context.note("stream.settlement.failed", { error: failureText(error) });
  })), Effect.asVoid);
}
