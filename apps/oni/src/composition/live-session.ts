import { Bundle, Core } from "@oni/agent";
import { Gateway, Message, PlainValueSchema, Tool, toolResultText, type Model } from "@oni/protocol";
import { Clock, Effect, Stream } from "effect";
import { z } from "zod";
import { ThrownError } from "../thrown";
import { refuseEvidenceOnly } from "../bundles/resident";

const LiveEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("utterance_start") }).strict(),
  z.object({ type: z.literal("utterance_delta"), text: z.string() }).strict(),
  z.object({ type: z.literal("utterance_end") }).strict(),
  z.object({ type: z.literal("tool_call"), call: Tool.Call }).strict(),
  z.object({ type: z.literal("audio_out"), part: Gateway.MediaPart.extend({ kind: z.literal("audio") }) }).strict(),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;

/** Adapters own bytes and socket lifetime; the runner sees only content and completed calls. */
export interface LiveSession {
  readonly model: Model.Ref;
  readonly port: {
    readonly events: AsyncIterable<LiveEvent>;
    readonly send: (part: Message.Part) => Promise<void>;
  };
  readonly output: (part: Message.Part) => Promise<void>;
}

function failure(cause: string): Core.AgentFailure {
  return new Core.AgentFailure({ operation: "live.session", cause });
}

/** A captured session generation owns the dispatcher and every boundary commit. */
export function createLiveSessionRunner(
  live: LiveSession,
  runtime: Core.SessionRuntimeOptions,
): Core.SessionRunner {
  return (input) => Effect.gen(function* () {
    const dispatcher = yield* Bundle.createTurnDispatcher(input, runtime);
    yield* dispatcher.executor.recover();
    const entropy = yield* Core.Entropy;
    const clock = yield* Clock.clockWith(Effect.succeed);
    const now = () => clock.currentTimeMillisUnsafe();
    let utterance: Message.WithParts | undefined;
    let text = "";
    const io = (operation: () => Promise<void>) => Effect.tryPromise({
      try: operation,
      catch: ThrownError.transform((error) => failure(error.message)).parse,
    });
    const identity = (message: Message.WithParts) => ({
      id: entropy.id(), sessionID: input.sessionId, messageID: message.info.id,
    });
    const consume = (event: LiveEvent): Effect.Effect<void, Core.ExecutionError> => Effect.gen(function* () {
      if (event.type === "utterance_start") {
        if (utterance !== undefined) return yield* failure("overlapping utterance");
        utterance = {
          info: {
            id: entropy.id(), sessionID: input.sessionId, role: "assistant",
            parentID: input.messages.at(-1)?.id ?? input.actionId,
            modelID: live.model.id, providerID: live.model.provider, agent: input.role,
            time: { created: now() },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [],
        };
        return;
      }
      const message = utterance;
      if (message === undefined) return yield* failure("event outside utterance");
      switch (event.type) {
        case "utterance_delta": {
          const last = message.parts.at(-1);
          if (last?.type === "text") last.text += event.text;
          else message.parts.push({ ...identity(message), type: "text", text: event.text });
          return;
        }
        case "audio_out": {
          const part: Message.FilePart = { ...identity(message), type: "file", ...event.part };
          message.parts.push(part);
          yield* io(() => live.output(part));
          return;
        }
        case "tool_call": {
          const start = now();
          const result = input.authority === "evidence_only"
            ? refuseEvidenceOnly(event.call)
            : yield* dispatcher.execute(event.call, {
                sessionId: input.sessionId, turnId: input.turnId, signal: input.signal,
              });
          const time = { start, end: now() };
          const part: Message.ToolPart = {
            ...identity(message), type: "tool", callID: event.call.id, tool: event.call.tool,
            state: result.isError
              ? { status: "error", input: event.call.input, error: toolResultText(result), time }
              : { status: "completed", input: event.call.input, output: toolResultText(result), title: event.call.tool, metadata: {}, time },
          };
          message.parts.push(part);
          yield* io(() => live.port.send(part));
          const drained = yield* input.boundary("after_tools");
          if (drained.interrupted) return yield* new Core.Interrupted();
          return;
        }
        case "utterance_end": {
          const snapshot = {
            ...message, info: { ...message.info, time: { ...message.info.time, completed: now() }, finish: "stop" },
          };
          const committed = yield* dispatcher.executor.run(
            { kind: "message", op: "assistant", intent: { messageId: message.info.id }, effect: {} },
            () => Effect.succeed(PlainValueSchema.parse(snapshot)),
          );
          if (committed.terminal !== "executed") return yield* failure(`assistant refused: ${committed.reason}`);
          const recorded = Message.WithParts.parse(committed.value);
          text += recorded.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
          utterance = undefined;
          const drained = yield* input.boundary("after_llm");
          if (drained.interrupted) return yield* new Core.Interrupted();
          return;
        }
        default: {
          const exhaustive: never = event;
          return exhaustive;
        }
      }
    });
    yield* Stream.fromAsyncIterable(live.port.events, (error) => failure(String(error))).pipe(
      Stream.runForEach((raw) => Effect.try({
        try: () => LiveEvent.parse(raw),
        catch: () => failure("invalid live event"),
      }).pipe(Effect.flatMap(consume))),
      Effect.raceFirst(Core.interruptOn(input.signal)),
    );
    if (utterance !== undefined) return yield* failure("unfinished utterance");
    return { kind: "result", text };
  });
}
