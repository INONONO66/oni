import { z } from "zod";
import { ChannelsFailure } from "../../errors.js";
import { kernelDeliveryReceipt } from "../../support/deliver.js";
import type { ChannelProvider, OwnerArm } from "../contract.js";
import { KAKAOTALK_MEDIA_LIMITS, KAKAOTALK_RENDER } from "./format.js";
import { type KakaoTalkOwnerCredentials, KakaoTalkOwnerAdapter } from "./owner.js";
import { type KakaoTalkOwnerSdk, kakaoTalkOwnerSdk } from "./owner-sdk.js";

/**
 * The Owner-identity arm (#1569 lane 7): the account's LOCO push listener
 * under the declared posture, delivery and typing into chats as the Owner,
 * mounted as `kakaotalk:owner` (a delivery route only when the declaration
 * grants outbound).
 */
function createKakaoTalkOwnerArm(sdk: KakaoTalkOwnerSdk = kakaoTalkOwnerSdk()): OwnerArm<KakaoTalkOwnerCredentials> {
  return {
    credentials: z
      .object({
        oauthToken: z.string().min(1),
        userId: z.string().min(1),
        deviceUuid: z.string().min(1).optional(),
        deviceType: z.enum(["pc", "tablet"]).optional(),
      })
      .strict(),
    preconditions: [
      "Owner session from the KakaoTalk passcode login (a registered device's OAuth token, user id and device uuid), sealed into the vault (the login helper lands with its own lane)",
      "the Owner accepts automation under their own account: one session per device slot, a second login on the same slot kicks this one",
      "AGENT_MESSENGER_CONFIG_DIR names where the SDK keeps the LOCO sync state (no secret)",
    ],
    capabilities: { deliver: true, react: false, media: KAKAOTALK_MEDIA_LIMITS, typing: true },
    listen: true,
    create(credentials, posture, publish, options) {
      const surface = new KakaoTalkOwnerAdapter(credentials, posture, publish, options, sdk);
      return {
        surface,
        account: () => surface.account(),
        deliveryRoute: (externalId, payload, idempotencyKey, conversation) =>
          surface.deliver(externalId, payload, idempotencyKey, conversation).then(kernelDeliveryReceipt),
        typingRoute: {
          everyMs: 8_000,
          open: (externalId, conversation) => surface.openTyping(externalId, conversation),
          pulse: (conversation) => surface.typing(conversation),
        },
      };
    },
  };
}

/**
 * KakaoTalk (#1569 lane 7): an Owner-only platform — a person's chats have
 * no bot account, so the provider's bot arm refuses every declaration and
 * the platform is reached through its `owner` arm alone (`identity: owner`).
 */
export function createKakaoTalkProvider(
  ownerSdk: KakaoTalkOwnerSdk = kakaoTalkOwnerSdk(),
): ChannelProvider<never, "kakaotalk", KakaoTalkOwnerCredentials> {
  return {
    id: "kakaotalk",
    ingest: "socket",
    capabilities: {
      deliver: true,
      webhook: false,
      render: KAKAOTALK_RENDER,
      media: false,
      react: false,
      typing: true,
    },
    owner: createKakaoTalkOwnerArm(ownerSdk),
    credentials: z.custom<never>(() => false, {
      message: "kakaotalk has no bot account; declare the instance with identity: owner",
    }),
    settings: z.record(z.string(), z.never()),
    preconditions: ["KakaoTalk has no bot account: declare the instance with identity: owner"],
    create() {
      throw new ChannelsFailure({
        operation: "kakaotalk.create",
        cause: "kakaotalk has no bot account; declare the instance with identity: owner",
      });
    },
  };
}

export const KakaoTalkProvider: ChannelProvider<never, "kakaotalk", KakaoTalkOwnerCredentials> =
  createKakaoTalkProvider();
