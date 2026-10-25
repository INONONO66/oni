import { z } from "zod";
import { DeliveryNotSent } from "../../errors.js";
import { kernelDeliveryReceipt } from "../../support/deliver.js";
import { type ChannelProvider, WEBHOOK_TEXT_CAPABILITIES } from "../contract.js";
import { A2AAdapter, type A2ACardFacts, type PeerResolver } from "./surface.js";
export type { A2ACardFacts, PeerResolver } from "./surface.js";
import { A2ACredentials } from "./types.js";

/**
 * A2A (#1569 lane 9c): one declared instance per peer. The door every
 * instance mounts admits every declared peer at request time, so the
 * declarations, not the mount, are the roster; a peer with a `url` is
 * also reachable as the `a2a:<id>` contact on `send_message`.
 */
export function createA2AProvider(peers: PeerResolver, card: A2ACardFacts): ChannelProvider<A2ACredentials, "a2a"> {
  return {
    id: "a2a",
    ingest: "webhook",
    // The answer is a text part; the peer renders it as it sees fit.
    capabilities: WEBHOOK_TEXT_CAPABILITIES,
    credentials: A2ACredentials,
    settings: z.record(z.string(), z.never()),
    preconditions: [
      "the peer presents its declared bearer at POST /a2a and reads the card at /.well-known/agent-card.json; a peer with a url is written to with the same bearer",
    ],
    create(_credentials, _config, publish, options) {
      const surface = new A2AAdapter(publish, { now: options.now, id: options.id, run: options.run }, peers, card);
      return {
        surface,
        // An answer lands on the task the conversation names; a peer is written to cold through the a2a: contact.
        deliveryRoute: async (externalId, payload, key, conversation) => {
          if (conversation === undefined)
            throw new DeliveryNotSent({
              operation: "a2a.deliver",
              cause: "an a2a answer lands on a task; the conversation names it — write to a peer through its a2a: contact",
            });
          return kernelDeliveryReceipt(await surface.deliver(externalId, payload, key, conversation));
        },
        webhookHandler: (request) => surface.handleWebhook(request),
      };
    },
  };
}
