import type { Message, Tool } from "@openomni/protocol";

/** The streaming callback contract of `run()`; distinct from the unrelated `BusEvent.Sink` observation port. */
export interface Sink {
  onMessage: (message: Message.WithParts) => void;
  /** Every onToolResult pairs with a preceding onToolCall (an unmatched result emits no callback, interruptions settle as error results); the agent's tracking sink builds its notifications from these pairs. */
  onToolCall: (call: Tool.Call) => void;
  onToolResult: (result: Tool.Result) => void;
}
