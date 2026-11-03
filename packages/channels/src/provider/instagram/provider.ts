import { z } from "zod";
import { ChannelsFailure } from "../../errors.js";
import { kernelDeliveryReceipt } from "../../support/deliver.js";
import type { ChannelProvider, AccountArm } from "../contract.js";
import { INSTAGRAM_RENDER } from "./format.js";
import { type InstagramAccountCredentials, InstagramAccountAdapter } from "./account.js";
import { type InstagramAccountSdk, instagramAccountSdk } from "./account-sdk.js";

/** The session the login helper sealed: the SDK's session state as JSON, cookies included. */
const SessionJson = z.string().min(1).refine(
  (session) => {
    try {
      const parsed: { cookies?: string } = JSON.parse(session);
      return typeof parsed.cookies === "string" && parsed.cookies.length > 0;
    } catch {
      return false;
    }
  },
  { message: "session must be the Instagram session state JSON with its cookies" },
);

/**
 * The Account-identity arm (#1569 lane 7): the account's inbox listener and
 * delivery into threads as the Account, mounted by
 * declaration id (a delivery route only when the declaration grants
 * outbound).
 */
function createInstagramAccountArm(sdk: InstagramAccountSdk = instagramAccountSdk()): AccountArm<InstagramAccountCredentials> {
  return {
    credentials: z.object({ session: SessionJson }).strict(),
    preconditions: [
      "Account session from the Instagram login (password, 2FA or challenge), sealed into the vault as the SDK's session state (the login helper lands with its own lane)",
      "the Account accepts automation under their own account: Instagram watches for automated behaviour, so keep the account's sends sparse",
    ],
    capabilities: { deliver: true, react: false, media: false, typing: false, voice: false },
    listen: true,
    create(credentials, publish, options) {
      const surface = new InstagramAccountAdapter(credentials, publish, options, sdk);
      return {
        surface,
        account: () => surface.account(),
        deliveryRoute: (externalId, payload, idempotencyKey, conversation) =>
          surface.deliver(externalId, payload, idempotencyKey, conversation).then(kernelDeliveryReceipt),
      };
    },
  };
}

/**
 * Instagram (#1569 lane 7): an Account-only platform — there is no bot
 * account, so the provider's bot arm refuses every declaration and the
 * platform is reached through its `account` arm alone (`identity: account`).
 */
export function createInstagramProvider(
  accountSdk: InstagramAccountSdk = instagramAccountSdk(),
): ChannelProvider<never, "instagram", InstagramAccountCredentials> {
  return {
    id: "instagram",
    ingest: "socket",
    capabilities: {
      deliver: true,
      direct: false,
      webhook: false,
      render: INSTAGRAM_RENDER,
      media: false,
      react: false,
      typing: false,
      voice: false,
    },
    account: createInstagramAccountArm(accountSdk),
    credentials: z.custom<never>(() => false, {
      message: "instagram has no bot account; use the account arm",
    }),
    preconditions: ["Instagram has no bot account: use the account arm"],
    create() {
      throw new ChannelsFailure({
        operation: "instagram.create",
        cause: "instagram has no bot account; use the account arm",
      });
    },
  };
}

export const InstagramProvider: ChannelProvider<never, "instagram", InstagramAccountCredentials> =
  createInstagramProvider();
