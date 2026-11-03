import { z } from "zod";
import { ChannelsFailure } from "../../errors.js";
import type { ChannelProvider, AccountArm } from "../contract.js";
import { kernelDeliveryRoute } from "../delivery-route.js";
import { KAKAOTALK_MEDIA_LIMITS, KAKAOTALK_RENDER } from "./format.js";
import { type KakaoTalkAccountCredentials, KakaoTalkAccountAdapter } from "./account.js";
import { type KakaoTalkAccountSdk, kakaoTalkAccountSdk } from "./account-sdk.js";

/**
 * The Account-identity arm (#1569 lane 7): the account's LOCO push listener
 * emitting facts, delivery and typing into chats as the Account,
 * mounted by declaration id (a delivery route only when the declaration
 * grants outbound).
 */
function createKakaoTalkAccountArm(sdk: KakaoTalkAccountSdk = kakaoTalkAccountSdk()): AccountArm<KakaoTalkAccountCredentials> {
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
      "Account session from the KakaoTalk passcode login (a registered device's OAuth token, user id and device uuid), sealed into the vault (the login helper lands with its own lane)",
      "the Account accepts automation under their own account: one session per device slot, a second login on the same slot kicks this one",
      "AGENT_MESSENGER_CONFIG_DIR names where the SDK keeps the LOCO sync state (no secret)",
    ],
    capabilities: { deliver: true, react: false, media: KAKAOTALK_MEDIA_LIMITS, typing: true, voice: false },
    listen: true,
    create(credentials, publish, options) {
      const surface = new KakaoTalkAccountAdapter(credentials, publish, options, sdk);
      return {
        surface,
        account: () => surface.account(),
        deliveryRoute: kernelDeliveryRoute(surface),
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
 * KakaoTalk (#1569 lane 7): an Account-only platform — a person's chats have
 * no bot account, so the provider's bot arm refuses every declaration and
 * the platform is reached through its `account` arm alone (`identity: account`).
 */
export function createKakaoTalkProvider(
  accountSdk: KakaoTalkAccountSdk = kakaoTalkAccountSdk(),
): ChannelProvider<never, "kakaotalk", KakaoTalkAccountCredentials> {
  return {
    id: "kakaotalk",
    ingest: "socket",
    capabilities: {
      deliver: true,
      direct: false,
      webhook: false,
      render: KAKAOTALK_RENDER,
      media: false,
      react: false,
      typing: true,
      voice: false,
    },
    account: createKakaoTalkAccountArm(accountSdk),
    credentials: z.custom<never>(() => false, {
      message: "kakaotalk has no bot account; use the account arm",
    }),
    preconditions: ["KakaoTalk has no bot account: use the account arm"],
    create() {
      throw new ChannelsFailure({
        operation: "kakaotalk.create",
        cause: "kakaotalk has no bot account; use the account arm",
      });
    },
  };
}

export const KakaoTalkProvider: ChannelProvider<never, "kakaotalk", KakaoTalkAccountCredentials> =
  createKakaoTalkProvider();
