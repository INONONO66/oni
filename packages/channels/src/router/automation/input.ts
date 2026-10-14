import { Channel, type Gateway, Ingress } from "@openomni/protocol";
import type { ChannelStores } from "../stores.js";
import { resolveChannelGrant } from "../channel-grant.js";
import { inboundIdOf } from "../inbound-id.js";

/** The surface label an inbound keys on: a DM, a channel, or one thread of it. */
export function ingressSurfaceKey(facts: Gateway.IngressFacts): string {
  return Channel.SurfaceKey.fromChannel({
    surface: facts.surface, namespace: facts.workspaceId ?? facts.surface,
    kind: facts.dm ? "dm" : "channel", id: facts.channelId,
    ...(facts.reply?.threadId === undefined ? {} : { threadId: facts.reply.threadId }),
  });
}

export function ingressInput(stores: ChannelStores,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  facts: Gateway.IngressFacts, at: number) {
  const identities = facts.addressees.flatMap((addressee) => {
    const resolved = stores.actors.resolveEndpoint(facts.surface, addressee.externalId, facts.workspaceId);
    return resolved === undefined ? [] : [resolved.identity];
  });
  const addressed = facts.dm || identities.some((identity) => identity.kind === "resident");
  // The surface grant is read once per inbound: the perimeter posture and the
  // kernel route both consume this resolution.
  const channel = resolveChannelGrant(stores, {
    surface: facts.surface,
    ...(facts.workspaceId === undefined ? {} : { workspace: facts.workspaceId }),
    channel: facts.channelId,
    sender: sender.externalId,
  });
  const input = Ingress.Input.parse({
    eventId: inboundIdOf(facts), surface: facts.surface, event: facts.event ?? "message",
    secretRef: facts.secretRef, githubEvent: facts.githubEvent,
    channelId: facts.channelId, threadId: facts.reply?.threadId, workspaceId: facts.workspaceId,
    author: facts.author ?? { externalId: sender.externalId, isBot: false },
    dm: facts.dm, mentionsBot: addressed, body: facts.render, receivedAt: at,
  });
  return { input, identities, addressed, channel };
}
