import type { Channel } from "@oni/protocol";

/** Bot and Owner copies of one platform message share its workspace/channel/event key. */
function inboundKey(message: Channel.InboundMessage): string {
  const { facts } = message;
  return [facts.surface, facts.workspaceId ?? "", facts.channelId, facts.eventId]
    .map(encodeURIComponent)
    .join(":");
}

/**
 * The composition hands each physical message to the routing
 * handler once: a copy that arrives while another copy is in flight
 * waits for that outcome and is dropped only when the first copy was
 * admitted; a refused or failed handoff lets the next copy carry the message
 * from another receiving account. Admitted keys are kept in a bounded window.
 */
export function inboundOnce(handler: Channel.MessageHandler, capacity = 4096): Channel.MessageHandler {
  const admitted = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const remember = (key: string) => {
    admitted.add(key);
    if (admitted.size > capacity) {
      const oldest = admitted.values().next().value;
      if (oldest !== undefined) admitted.delete(oldest);
    }
  };
  const carry = async (message: Channel.InboundMessage, key: string): Promise<void> => {
    if (admitted.has(key)) return;
    const pending = inFlight.get(key);
    if (pending !== undefined) {
      // The other instance's copy is being admitted: wait for it, then carry
      // this copy only if that one was refused.
      const outcome = await pending.then(
        () => "admitted" as const,
        () => "refused" as const,
      );
      if (outcome === "admitted") return;
      return carry(message, key);
    }
    const attempt = handler(message);
    inFlight.set(key, attempt);
    try {
      await attempt;
      remember(key);
    } finally {
      if (inFlight.get(key) === attempt) inFlight.delete(key);
    }
  };
  return (message) => carry(message, inboundKey(message));
}
