import { z } from "zod";
import { ChannelsFailure } from "../../errors.js";
import { kernelDeliveryReceipt } from "../../support/deliver.js";
import { type ChannelProvider, type AccountArm, WEBHOOK_TEXT_CAPABILITIES } from "../contract.js";
import { LinearAdapter } from "./surface.js";
import type { LinearAccountCredentials } from "./types.js";

/**
 * The Account-identity arm (#1569 lane 9b): the workspace webhook and comments
 * as the Account, mounted by declaration id. A delivery route exists only
 * when the declaration grants outbound; rules control replies.
 */
const LinearAccountArm: AccountArm<LinearAccountCredentials> = {
  credentials: z
    .object({
      secret: z.string().min(1),
      token: z.string().min(1).optional(),
      accountUserId: z.string().min(1).optional(),
    })
    .strict(),
  preconditions: [
    "a workspace webhook for the Issue and Comment resources posts to the public /linear/webhook endpoint with the signing secret",
    "the Account's personal API key comments back as the Account and names the Account's own actions; without it the instance is ingress-only and mentions go unread",
  ],
  capabilities: { deliver: true, react: false, media: false, typing: false, voice: false },
  listen: true,
  create(credentials, publish, options) {
    const surface = new LinearAdapter(credentials, publish, {
      instance: options.instance,
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
 * Linear (#1569 lane 9b): an Account-only platform — a personal API key is a
 * person's, so the provider's bot arm refuses every declaration and the
 * platform is reached through its `account` arm alone (`identity: account`).
 */
export const LinearProvider: ChannelProvider<never, "linear", LinearAccountCredentials> = {
  id: "linear",
  ingest: "webhook",
  // Linear renders markdown natively and comments carry no driver-enforced limit.
  capabilities: WEBHOOK_TEXT_CAPABILITIES,
  account: LinearAccountArm,
  credentials: z.custom<never>(() => false, {
    message: "linear has no bot account; use the account arm",
  }),
  preconditions: ["Linear has no bot account (a personal API key is the Account's): use the account arm"],
  create() {
    throw new ChannelsFailure({
      operation: "linear.create",
      cause: "linear has no bot account; use the account arm",
    });
  },
};
