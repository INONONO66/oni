import type { Gateway } from "@openomni/protocol";

/** The one inbound-id construction: surface, workspace, channel and eventId, URI-encoded and joined. */
export function inboundIdOf(facts: Gateway.IngressFacts): string {
  if (facts.surface === "alarm" && facts.event === "schedule") return facts.eventId;
  return [facts.surface, facts.workspaceId ?? "", facts.channelId, facts.eventId]
    .map(encodeURIComponent)
    .join(":");
}
