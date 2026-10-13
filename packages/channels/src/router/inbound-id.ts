import type { IngressFacts } from "../automation/facts.js";

/** The one inbound-id construction: surface, workspace, channel and eventId, URI-encoded and joined. */
export function inboundIdOf(facts: IngressFacts): string {
  if (facts.surface === "alarm" && facts.event === "schedule") return facts.eventId;
  return [facts.surface, facts.workspaceId ?? "", facts.channelId, facts.eventId]
    .map(encodeURIComponent)
    .join(":");
}
