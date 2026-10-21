import type { Gateway } from "@oni/protocol";

/**
 * The one inbound-id construction: surface, workspace, channel and eventId,
 * URI-encoded and joined. The Owner instance's copy of a message (#1569
 * lane 6) carries its own id: the bot's copy may have been filtered and
 * recorded, and that decision is the bot's, not a replay to hold the
 * Owner's copy to. The composition keeps one physical message from being
 * admitted twice (`inboundOnce`).
 */
export function inboundIdOf(facts: Gateway.IngressFacts): string {
  if (facts.surface === "alarm" && facts.event === "schedule") return facts.eventId;
  return [
    facts.surface,
    facts.workspaceId ?? "",
    facts.channelId,
    facts.eventId,
    ...(facts.receivedBy === "owner" ? ["owner"] : []),
  ]
    .map(encodeURIComponent)
    .join(":");
}
