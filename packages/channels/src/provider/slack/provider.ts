import { z } from "zod";
import type { ChannelProvider, AccountArm } from "../contract.js";
import { kernelDeliveryRoute } from "../delivery-route.js";
import { SLACK_MEDIA_LIMITS, SLACK_RENDER } from "./format.js";
import { SlackAccountAdapter } from "./account.js";
import { type SlackAccountSdk, slackAccountSdk } from "./account-sdk.js";
import { type SlackSdk, slackSdk } from "./sdk.js";
import { SlackAdapter } from "./surface.js";

interface SlackCredentials {
  /** Bot token (`xoxb-`): identity, posting, DMs. */
  readonly botToken: string;
  /** App-level token (`xapp-`) with `connections:write`: opens the Socket Mode URL, nothing else. */
  readonly appToken: string;
}

/** The user account session (#1569): the client token and the `d` cookie the QR login produced. */
interface SlackAccountCredentials {
  readonly token: string;
  readonly cookie: string;
}

/**
 * The Account-identity arm (#1569 lanes 5 and 6): delivery as the Account's
 * account through the user SDK, mounted by declaration id (a delivery route
 * only when the declaration grants outbound), and the account's RTM listener
 * emitting facts for the router. No media upload through the account.
 */
function createSlackAccountArm(sdk: SlackAccountSdk = slackAccountSdk()): AccountArm<SlackAccountCredentials> {
  return {
    credentials: z
      .object({
        token: z.string().startsWith("xoxc-"),
        cookie: z.string().min(1),
      })
      .strict(),
    preconditions: [
      "Account session from the Slack QR login, sealed into the vault (the login helper lands with its own lane): client token xoxc- plus the d cookie",
      "the Account accepts automation under their own account (declared outbound grant)",
      "live huddles require Linux Chromium, PipeWire-Pulse devices and an active room that the Account account can join without switching away from its existing device",
      "automatic huddle handling requires the RTM room-to-conversation association and a rule that admits unaddressed call facts",
    ],
    capabilities: { deliver: true, react: true, media: false, typing: false, voice: true },
    listen: true,
    create(credentials, publish, options) {
      const surface = new SlackAccountAdapter(credentials, publish, options, sdk);
      return {
        surface,
        account: () => surface.account(),
        deliveryRoute: kernelDeliveryRoute(surface),
        voiceRoute: (input) => surface.joinVoice(input),
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
  accountSdk: SlackAccountSdk = slackAccountSdk(),
): ChannelProvider<SlackCredentials, "slack", SlackAccountCredentials> {
  return {
    id: "slack",
    ingest: "socket",
    capabilities: {
      deliver: true,
      direct: true,
      webhook: false,
      render: SLACK_RENDER,
      media: SLACK_MEDIA_LIMITS,
      react: true,
      typing: false,
      voice: false,
    },
    account: createSlackAccountArm(accountSdk),
    credentials: z
      .object({
        botToken: z.string().startsWith("xoxb-"),
        appToken: z.string().startsWith("xapp-"),
      })
      .strict(),
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
        deliveryRoute: kernelDeliveryRoute(surface),
      };
    },
  };
}

export const SlackProvider: ChannelProvider<SlackCredentials, "slack", SlackAccountCredentials> =
  createSlackProvider();
