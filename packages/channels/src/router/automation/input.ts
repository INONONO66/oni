import { type Gateway, Ingress } from "@oni/protocol";
import type { ChannelStores } from "../stores.js";
import { inboundIdOf } from "../inbound-id.js";

/** Each top-level channel message starts its own thread; a DM stays with its peer. */
export function ingressSurfaceKey(
  facts: Pick<Ingress.Message, "surface" | "instance" | "dm" | "channelId" | "eventId" | "reply">,
  peerId = facts.channelId,
): string {
  const instance = facts.instance ?? facts.surface;
  return facts.dm ? `${instance}:dm:${peerId}`
    : `${instance}:channel:${facts.channelId}:thread:${facts.reply?.threadId ?? facts.eventId}`;
}

export function ingressInput(stores: ChannelStores,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  facts: Ingress.Message, at: number) {
  const identities = facts.addressees.flatMap((addressee) => {
    const resolved = stores.actors.resolveEndpoint(facts.surface, addressee.externalId, facts.workspaceId);
    return resolved === undefined ? [] : [resolved.identity];
  });
  const addressed = facts.dm ||
    (facts.account !== undefined && (facts.addressees.some(({ externalId }) => externalId === facts.account) ||
      facts.quotes === facts.account)) ||
    (facts.reply?.threadId !== undefined && stores.surfaceKeys.lookup(ingressSurfaceKey(facts)) !== undefined);
  const input = Ingress.Message.parse({
    ...facts, eventId: inboundIdOf(facts), instance: facts.instance ?? facts.surface,
    surface: facts.surface, event: facts.event ?? "message",
    secretRef: facts.secretRef, githubEvent: facts.githubEvent,
    channelId: facts.channelId, threadId: facts.dm ? undefined : facts.reply?.threadId ?? facts.eventId,
    workspaceId: facts.workspaceId,
    author: facts.author ?? { externalId: sender.externalId, isBot: false },
    from: sender.externalId, addressed, receivedAt: at,
  });
  return { input, identities, addressed };
}
