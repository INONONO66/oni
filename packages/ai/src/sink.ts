import type { Message, Tool } from "@oni/protocol";

/** The streaming callback contract of `run()`; not the `BusEvent.Sink` observation port. */
export interface Sink {
  onMessage: (message: Message.WithParts) => void;
  /**
   * Every onToolResult pairs with a preceding onToolCall (an unmatched result emits no callback,
   * interruptions settle as error results); the agent's tracking sink builds its notifications from
   * these pairs.
   */
  onToolCall: (call: Tool.Call) => void;
  onToolResult: (result: Tool.Result) => void;
}
