import type { Gateway } from "@openomni/protocol";

/** The one inbound-id construction: surface, workspace, channel and eventId, URI-encoded and joined. */
export function inboundIdOf(facts: Gateway.IngressFacts): string {
  return [facts.surface, facts.workspaceId ?? "", facts.channelId, facts.eventId]
    .map(encodeURIComponent)
    .join(":");
}
