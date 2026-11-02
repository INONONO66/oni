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

type Dispatcher = Effect.Effect.Success<ReturnType<typeof Bundle.createTurnDispatcher>>;

/** One captured turn: the dispatcher plus the utterance under construction, which exists only between its start and end events. */
interface LiveTurn {
  readonly input: Core.SessionRunnerInput;
  readonly live: LiveSession;
  readonly dispatcher: Dispatcher;
  readonly id: () => string;
  readonly now: () => number;
  readonly spoken: string[];
  utterance: Message.WithParts | undefined;
}

function failure(cause: string): Core.AgentFailure {
  return new Core.AgentFailure({ operation: "live.session", cause });
}

const io = (operation: () => Promise<void>) => Effect.tryPromise({
  try: operation,
  catch: ThrownError.transform((error) => failure(error.message)).parse,
});

const partIdentity = (turn: LiveTurn, messageID: string) => ({
  id: turn.id(), sessionID: turn.input.sessionId, messageID,
});

function openUtterance(turn: LiveTurn): Effect.Effect<void, Core.AgentFailure> {
  if (turn.utterance !== undefined) return failure("overlapping utterance");
  turn.utterance = {
    info: {
      id: turn.id(), sessionID: turn.input.sessionId, role: "assistant",
      parentID: turn.input.messages.at(-1)?.id ?? turn.input.actionId,
      modelID: turn.live.model.id, providerID: turn.live.model.provider, agent: turn.input.role,
      time: { created: turn.now() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  };
  return Effect.void;
}

function appendDelta(turn: LiveTurn, message: Message.WithParts, text: string): void {
  const last = message.parts.at(-1);
  if (last?.type === "text") last.text += text;
  else message.parts.push({ ...partIdentity(turn, message.info.id), type: "text", text });
}

/**
 * A boundary drain hands the runner what the ledger consumed for this turn; the live model hears it
 * through the port, exactly as the text loop appends it to the next model call.
 */
function forwardDrained(turn: LiveTurn, boundary: "after_llm" | "after_tools"): Effect.Effect<void, Core.ExecutionError> {
  return Effect.gen(function* () {
    const drained = yield* turn.input.boundary(boundary);
    if (drained.interrupted) return yield* new Core.Interrupted();
    for (const drainedMessage of drained.messages) {
      const messageID = drainedMessage.id ?? turn.id();
      const content = drainedMessage.content ?? [{ kind: "text", text: drainedMessage.text }];
      for (const part of content) {
        const identity = partIdentity(turn, messageID);
        yield* io(() => turn.live.port.send(
          part.kind === "text" ? { ...identity, type: "text", text: part.text } : { ...identity, ...part, type: "file" },
        ));
      }
    }
  });
}

function runToolCall(turn: LiveTurn, message: Message.WithParts, call: Tool.Call): Effect.Effect<void, Core.ExecutionError> {
  return Effect.gen(function* () {
    const { input, dispatcher } = turn;
    const start = turn.now();
    const result = input.authority === "evidence_only"
      ? refuseEvidenceOnly(call)
      : yield* dispatcher.execute(call, { sessionId: input.sessionId, turnId: input.turnId, signal: input.signal });
    const time = { start, end: turn.now() };
    const part: Message.ToolPart = {
      ...partIdentity(turn, message.info.id), type: "tool", callID: call.id, tool: call.tool,
      state: result.isError
        ? { status: "error", input: call.input, error: toolResultText(result), time }
        : { status: "completed", input: call.input, output: toolResultText(result), title: call.tool, metadata: {}, time },
    };
    message.parts.push(part);
    yield* io(() => turn.live.port.send(part));
    yield* forwardDrained(turn, "after_tools");
  });
}

/** The one assistant commit per utterance: the executor's pre-gate sees the whole message, never a delta. */
function closeUtterance(turn: LiveTurn, message: Message.WithParts): Effect.Effect<void, Core.ExecutionError> {
  return Effect.gen(function* () {
    const snapshot = {
      ...message, info: { ...message.info, time: { ...message.info.time, completed: turn.now() }, finish: "stop" },
    };
    const committed = yield* turn.dispatcher.executor.run(
      { kind: "message", op: "assistant", intent: { messageId: message.info.id }, effect: {} },
      () => Effect.succeed(PlainValueSchema.parse(snapshot)),
    );
    if (committed.terminal !== "executed") return yield* failure(`assistant refused: ${committed.reason}`);
    const recorded = Message.WithParts.parse(committed.value);
    turn.spoken.push(recorded.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join(""));
    turn.utterance = undefined;
    yield* forwardDrained(turn, "after_llm");
  });
}

function consume(turn: LiveTurn, event: LiveEvent): Effect.Effect<void, Core.ExecutionError> {
  if (event.type === "utterance_start") return openUtterance(turn);
  const message = turn.utterance;
  if (message === undefined) return failure("event outside utterance");
  switch (event.type) {
    case "utterance_delta":
      return Effect.sync(() => appendDelta(turn, message, event.text));
    case "audio_out": {
      const part: Message.FilePart = { ...partIdentity(turn, message.info.id), type: "file", ...event.part };
      message.parts.push(part);
      return io(() => turn.live.output(part));
    }
    case "tool_call":
      return runToolCall(turn, message, event.call);
    case "utterance_end":
      return closeUtterance(turn, message);
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** A captured session generation owns the dispatcher and every boundary commit. */
export function createLiveSessionRunner(
  live: LiveSession,
  runtime: Core.SessionRuntimeOptions,
): Core.SessionRunner {
  return (input) => Effect.gen(function* () {
    const dispatcher = yield* Bundle.createTurnDispatcher(input, runtime);
    yield* dispatcher.executor.recover();
    const { id } = yield* Core.Entropy;
    const clock = yield* Clock.clockWith(Effect.succeed);
    const turn: LiveTurn = {
      input, live, dispatcher, id, now: () => clock.currentTimeMillisUnsafe(), spoken: [], utterance: undefined,
    };
    yield* Stream.fromAsyncIterable(live.port.events, (error) => failure(String(error))).pipe(
      Stream.runForEach((raw) => Effect.try({
        try: () => LiveEvent.parse(raw),
        catch: () => failure("invalid live event"),
      }).pipe(Effect.flatMap((event) => consume(turn, event)))),
      Effect.raceFirst(Core.interruptOn(input.signal)),
    );
    if (turn.utterance !== undefined) return yield* failure("unfinished utterance");
    return { kind: "result", text: turn.spoken.join("\n") };
  });
}
