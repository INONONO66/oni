import { z } from "zod";
import { ChannelsFailure } from "../../errors.js";
import { kernelDeliveryReceipt } from "../../support/deliver.js";
import type { ChannelProvider, OwnerArm } from "../contract.js";
import { LinearAdapter } from "./surface.js";
import type { LinearOwnerCredentials } from "./types.js";

/**
 * The Owner-identity arm (#1569 lane 9b): the workspace webhook under the
 * declared posture and comments as the Owner, mounted as `linear:owner` (a
 * delivery route only when the declaration grants outbound; the reply door
 * answers through it only when the declaration auto-replies).
 */
const LinearOwnerArm: OwnerArm<LinearOwnerCredentials> = {
  credentials: z
    .object({
      secret: z.string().min(1),
      token: z.string().min(1).optional(),
      ownerUserId: z.string().min(1).optional(),
    })
    .strict(),
  preconditions: [
    "a workspace webhook for the Issue and Comment resources posts to the public /linear/webhook endpoint with the signing secret",
    "the Owner's personal API key comments back as the Owner and names the Owner's own actions; without it the instance is ingress-only and mentions go unread",
  ],
  capabilities: { deliver: true, react: false, media: false, typing: false, voice: false },
  listen: true,
  create(credentials, posture, publish, options) {
    const surface = new LinearAdapter(credentials, posture, publish, {
      now: options.now,
      id: options.id,
      run: options.run,
    });
    return {
      surface,
      // A comment lands on an issue: the conversation names it; a person has no issue of their own to be reached on.
      deliveryRoute: async (_externalId, payload, key, conversation) =>
        conversation === undefined
          ? { value: "rejected" as const }
          : kernelDeliveryReceipt(await surface.deliver(conversation.channelId, payload, key)),
      webhookHandler: (request) => surface.handleWebhook(request),
    };
  },
};

/**
 * Linear (#1569 lane 9b): an Owner-only platform — a personal API key is a
 * person's, so the provider's bot arm refuses every declaration and the
 * platform is reached through its `owner` arm alone (`identity: owner`).
 */
export const LinearProvider: ChannelProvider<never, "linear", LinearOwnerCredentials> = {
  id: "linear",
  ingest: "webhook",
  capabilities: {
    deliver: true,
    webhook: true,
    // Linear renders markdown natively and comments carry no driver-enforced limit.
    render: { renderMarkdown: (markdown: string) => markdown, messageLimit: null },
    media: false,
    react: false,
    typing: false,
    voice: false,
  },
  owner: LinearOwnerArm,
  credentials: z.custom<never>(() => false, {
    message: "linear has no bot account; declare the instance with identity: owner",
  }),
  settings: z.record(z.string(), z.never()),
  preconditions: ["Linear has no bot account (a personal API key is the Owner's): declare the instance with identity: owner"],
  create() {
    throw new ChannelsFailure({
      operation: "linear.create",
      cause: "linear has no bot account; declare the instance with identity: owner",
    });
  },
};
