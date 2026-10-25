import type { PlainObject, PlainValue, Tool } from "@oni/protocol";
import type { Effect, Scope, Stream } from "effect";
import type { LlmError } from "../errors";

/**
 * One live speech session with a realtime model over a single socket: audio
 * both ways as PCM16 little-endian, 24_000 Hz, mono; finished function calls
 * out and their results back. Separate from `run`, which is one text attempt.
 */

/** A function call the model finished; its arguments are a validated JSON object. */
export interface RealtimeToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: PlainObject;
}

export type RealtimeEvent =
  | { readonly type: "transcript"; readonly speaker: "user" | "assistant"; readonly text: string }
  | { readonly type: "error"; readonly reason: string }
  | { readonly type: "closed"; readonly reason: string };

export interface RealtimeSession {
  /** Each finished call once per call id; ends when the session closes. */
  readonly toolCalls: Stream.Stream<RealtimeToolCall>;
  readonly events: Stream.Stream<RealtimeEvent>;
  /**
   * Answers one pending call: `function_call_output`, then `response.create`.
   * Refused typed after close, or for a call id that is not pending.
   */
  readonly respondTool: (callId: string, output: PlainValue) => Effect.Effect<void, LlmError>;
}

export interface RealtimeOpenInput {
  readonly instructions: string;
  readonly tools: readonly Tool.Spec[];
  /** The caller's speech: PCM16 little-endian, 24_000 Hz, mono. */
  readonly audioIn: Stream.Stream<Uint8Array>;
  /** The model's speech in the same format, written in order. */
  readonly audioOut: (pcm: Uint8Array) => Effect.Effect<void>;
}

export interface Realtime {
  /** Opens one socket on the first provider row that declares `realtime`; closing the scope closes it. */
  readonly open: (input: RealtimeOpenInput) => Effect.Effect<RealtimeSession, LlmError, Scope.Scope>;
}
