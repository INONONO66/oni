import type { Message } from "@oni/protocol";
import { Effect } from "effect";
import type { LlmError } from "../errors";
import type { StreamEvent } from "../processor/event-schema";
import { run } from "../run";
import type { Sink } from "../sink";
import type { Phase } from "./decide";

export function attempt(input: Parameters<typeof run>[0], sink: Sink, dependencies: Parameters<typeof run>[2] & {
  readonly onDelta: () => void;
}) {
  let phase: Phase = "pre_request";
  let pending: Message.WithParts | undefined;
  const wrapped: Sink = {
    onMessage: (message) => {
      if (phase === "streaming") sink.onMessage(message);
      else pending = message;
    },
    onToolCall: (call) => { phase = "streaming"; sink.onToolCall(call); },
    onToolResult: sink.onToolResult,
  };
  async function* observe(stream: AsyncIterable<StreamEvent>) {
    for await (const event of stream) {
      if (phase === "pre_request" && (event.type.endsWith("-delta") || event.type === "tool-call")) {
        phase = "streaming";
        dependencies.onDelta();
        if (pending !== undefined) {
          sink.onMessage(pending);
          pending = undefined;
        }
      }
      yield event;
    }
  }
  return run(input, wrapped, { ...dependencies, observeStream: observe }).pipe(
    Effect.map((outcome) => ({
      outcome,
      phase,
      flush: () => { if (pending !== undefined) sink.onMessage(pending); },
    })),
    Effect.catch((error: LlmError) => Effect.succeed({
      outcome: { type: "failure" as const, error },
      phase,
      flush: () => { if (pending !== undefined) sink.onMessage(pending); },
    })),
  );
}
