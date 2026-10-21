import type { Channel } from "@oni/protocol";
import { ChannelsFailure } from "../errors";

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
