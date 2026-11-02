import type { Channel } from "@oni/protocol";
import { ChannelsFailure } from "../errors";

/** Bind trusted construction identity after platform normalization, before routing. */
export function instanceHandler(instance: string, handler: Channel.MessageHandler): Channel.MessageHandler {
  return (message) => handler({ ...message, facts: { ...message.facts, instance } });
}

export function requireHandler(
  handler: Channel.MessageHandler | null,
  surfaceId: string,
): Channel.MessageHandler {
  if (!handler) {
    throw new ChannelsFailure({
      operation: `${surfaceId}.start`,
      cause: "no message handler registered — call onMessage() before start()",
    });
  }
  return handler;
}
