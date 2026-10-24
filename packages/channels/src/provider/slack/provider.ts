import { kernelDeliveryReceipt } from "../../support/deliver.js";
import { z } from "zod";
import type { ChannelProvider, OwnerArm } from "../contract.js";
import { SLACK_MEDIA_LIMITS, SLACK_RENDER } from "./format.js";
import { SlackOwnerAdapter } from "./owner.js";
import { type SlackOwnerSdk, slackOwnerSdk } from "./owner-sdk.js";
import { type SlackSdk, slackSdk } from "./sdk.js";
import { SlackAdapter } from "./surface.js";

interface SlackCredentials {
  /** Bot token (`xoxb-`): identity, posting, DMs. */
  readonly botToken: string;
  /** App-level token (`xapp-`) with `connections:write`: opens the Socket Mode URL, nothing else. */
  readonly appToken: string;
}

/** The Owner's own account session (#1569): the client token and the `d` cookie the QR login produced. */
interface SlackOwnerCredentials {
  readonly token: string;
  readonly cookie: string;
}

/**
 * The Owner-identity arm (#1569 lanes 5 and 6): delivery as the Owner's
 * account through the user SDK, mounted as `slack:owner` (a delivery route
 * only when the declaration grants outbound), and the account's RTM listener
 * under the declared intake posture. No media upload through the account.
 */
function createSlackOwnerArm(sdk: SlackOwnerSdk = slackOwnerSdk()): OwnerArm<SlackOwnerCredentials> {
  return {
    credentials: z
      .object({
        token: z.string().startsWith("xoxc-"),
        cookie: z.string().min(1),
      })
      .strict(),
    preconditions: [
      "Owner session from the Slack QR login, sealed into the vault (the login helper lands with its own lane): client token xoxc- plus the d cookie",
      "the Owner accepts automation under their own account (declared outbound grant)",
    ],
    capabilities: { deliver: true, react: true, media: false, typing: false },
    listen: true,
    create(credentials, posture, publish, options) {
      const surface = new SlackOwnerAdapter(credentials, posture, publish, options, sdk);
      return {
        surface,
        account: () => surface.account(),
        deliveryRoute: (externalId, payload, idempotencyKey, conversation) =>
          surface
            .deliver(externalId, payload, idempotencyKey, conversation)
            .then(kernelDeliveryReceipt),
      };
    },
  };
}

/**
 * Slack over Socket Mode through the agent-messenger bot SDK (#1569): two
 * tokens by platform design, no public HTTP ingress. Endpoint keys are
 * workspace-mandatory — externalIds are `TEAM:USER` pairs because slack user
 * ids are only unique per workspace (docs/provisioning-and-providers.md
 * §endpoint-keys). Operator preconditions the credentials cannot carry:
 * Socket Mode enabled plus the `message.channels`/`message.im` event
 * subscriptions and `chat:write`/`im:write` bot scopes.
 *
 * The SDK seams are parameters so tests build the same provider over
 * scripted fakes; production takes the defaults.
 */
export function createSlackProvider(
  sdk: SlackSdk = slackSdk(),
  ownerSdk: SlackOwnerSdk = slackOwnerSdk(),
): ChannelProvider<SlackCredentials, "slack", SlackOwnerCredentials> {
  return {
    id: "slack",
    ingest: "socket",
    capabilities: {
      deliver: true,
      webhook: false,
      render: SLACK_RENDER,
      media: SLACK_MEDIA_LIMITS,
      react: true,
      typing: false,
    },
    owner: createSlackOwnerArm(ownerSdk),
    credentials: z
      .object({
        botToken: z.string().startsWith("xoxb-"),
        appToken: z.string().startsWith("xapp-"),
      })
      .strict(),
    settings: z.record(z.string(), z.never()),
    preconditions: [
      "Socket Mode enabled with an app-level token granted connections:write",
      "event subscriptions: message.channels and message.im",
      "bot scopes: chat:write, im:write, app_mentions:read, files:write, files:read, reactions:write",
      "bot invited to the target channels",
    ],
    create(credentials, config, publish, options) {
      const surface = new SlackAdapter(credentials, config, publish, options, sdk);
      return {
        surface,
        attachments: (ref, bounds) => surface.download(ref, bounds),
        deliveryRoute: (externalId, payload, idempotencyKey, conversation) =>
          surface
            .deliver(externalId, payload, idempotencyKey, conversation)
            .then(kernelDeliveryReceipt),
      };
    },
  };
}

export const SlackProvider: ChannelProvider<SlackCredentials, "slack", SlackOwnerCredentials> =
  createSlackProvider();
