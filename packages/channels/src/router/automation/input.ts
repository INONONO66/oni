import { type Gateway, Ingress } from "@openomni/protocol";
import type { ChannelStores } from "../stores.js";
import { inboundIdOf } from "../inbound-id.js";

export function ingressInput(stores: ChannelStores,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  facts: Gateway.IngressFacts, at: number) {
  const identities = facts.addressees.flatMap((addressee) => {
    const resolved = stores.actors.resolveEndpoint(facts.surface, addressee.externalId, facts.workspaceId);
    return resolved === undefined ? [] : [resolved.identity];
  });
  const addressed = facts.dm || identities.some((identity) => identity.kind === "resident");
  const input = Ingress.Input.parse({
    eventId: inboundIdOf(facts), surface: facts.surface, event: facts.event ?? "message",
    channelId: facts.channelId, threadId: facts.reply?.threadId, workspaceId: facts.workspaceId,
    author: facts.author ?? { externalId: sender.externalId, isBot: false },
    dm: facts.dm, mentionsBot: addressed, body: facts.render, receivedAt: at,
  });
  return { input, identities, addressed };
}
