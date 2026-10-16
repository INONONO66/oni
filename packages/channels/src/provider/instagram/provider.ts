import { z } from "zod";
import { ChannelsFailure } from "../../errors.js";
import { kernelDeliveryReceipt } from "../../support/deliver.js";
import type { ChannelProvider, OwnerArm } from "../contract.js";
import { INSTAGRAM_RENDER } from "./format.js";
import { type InstagramOwnerCredentials, InstagramOwnerAdapter } from "./owner.js";
import { type InstagramOwnerSdk, instagramOwnerSdk } from "./owner-sdk.js";

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
 * The Owner-identity arm (#1569 lane 7): the account's inbox listener under
 * the declared posture and delivery into threads as the Owner, mounted as
 * `instagram:owner` (a delivery route only when the declaration grants
 * outbound).
 */
function createInstagramOwnerArm(sdk: InstagramOwnerSdk = instagramOwnerSdk()): OwnerArm<InstagramOwnerCredentials> {
  return {
    credentials: z.object({ session: SessionJson }).strict(),
    preconditions: [
      "Owner session from the Instagram login (password, 2FA or challenge), sealed into the vault as the SDK's session state (the login helper lands with its own lane)",
      "the Owner accepts automation under their own account: Instagram watches for automated behaviour, so keep the account's sends sparse",
    ],
    capabilities: { deliver: true, react: false, media: false, typing: false },
    listen: true,
    create(credentials, posture, publish, options) {
      const surface = new InstagramOwnerAdapter(credentials, posture, publish, options, sdk);
      return {
        surface,
        deliveryRoute: (externalId, payload, idempotencyKey, conversation) =>
          surface.deliver(externalId, payload, idempotencyKey, conversation).then(kernelDeliveryReceipt),
      };
    },
  };
}

/**
 * Instagram (#1569 lane 7): an Owner-only platform — there is no bot
 * account, so the provider's bot arm refuses every declaration and the
 * platform is reached through its `owner` arm alone (`identity: owner`).
 */
export function createInstagramProvider(
  ownerSdk: InstagramOwnerSdk = instagramOwnerSdk(),
): ChannelProvider<never, "instagram", InstagramOwnerCredentials> {
  return {
    id: "instagram",
    ingest: "socket",
    capabilities: {
      deliver: true,
      webhook: false,
      render: INSTAGRAM_RENDER,
      media: false,
      react: false,
      typing: false,
    },
    owner: createInstagramOwnerArm(ownerSdk),
    credentials: z.custom<never>(() => false, {
      message: "instagram has no bot account; declare the instance with identity: owner",
    }),
    settings: z.record(z.string(), z.never()),
    preconditions: ["Instagram has no bot account: declare the instance with identity: owner"],
    create() {
      throw new ChannelsFailure({
        operation: "instagram.create",
        cause: "instagram has no bot account; declare the instance with identity: owner",
      });
    },
  };
}

export const InstagramProvider: ChannelProvider<never, "instagram", InstagramOwnerCredentials> =
  createInstagramProvider();
