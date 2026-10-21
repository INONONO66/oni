import type { Channel } from "@oni/protocol";

/** The physical message key two instances of one platform share: platform, workspace, channel, event. */
function inboundKey(message: Channel.InboundMessage): string {
  const { facts } = message;
  return [facts.surface, facts.workspaceId ?? "", facts.channelId, facts.eventId]
    .map(encodeURIComponent)
    .join(":");
}

/**
 * Two instances of one platform (#1569 lane 6: the bot and the Owner's own
 * account) can both observe one message — a mention of the Owner in a
 * channel the bot is in. The composition hands each physical message to the
 * routing handler once: a copy that arrives while another copy is in flight
 * waits for that outcome and is dropped only when the first copy was
 * admitted; a refused or failed handoff lets the next copy carry the message
 * (the bot's copy of an Owner mention is refused by a mention-only posture,
 * the Owner's copy then routes). Admitted keys are kept in a bounded window.
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
