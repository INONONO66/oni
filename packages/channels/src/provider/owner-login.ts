import { type DiscordOwnerLoginInput, discordOwnerLogin } from "./discord/owner-sdk.js";
import { type InstagramOwnerLoginInput, instagramOwnerLogin } from "./instagram/owner-sdk.js";
import { type KakaoTalkOwnerLoginInput, kakaoTalkOwnerLogin } from "./kakaotalk/owner-sdk.js";
import { type SlackOwnerLoginInput, slackOwnerLogin } from "./slack/owner-sdk.js";

/**
 * The Owner's own sign-in on each platform (#1569 lane 5b): each flow rides
 * the agent-messenger SDK through the platform's one seam and returns the
 * credential payload the platform's Owner arm admits — never touching the
 * SDK's own credential store. The composing CLI seals the payload through
 * the daemon's `channel_add`.
 */
export interface OwnerLogin {
  readonly slack: (input: SlackOwnerLoginInput) => Promise<{ token: string; cookie: string; workspace: string }>;
  readonly discord: (input: DiscordOwnerLoginInput) => Promise<{ token: string; userId?: string; username?: string }>;
  readonly instagram: (input: InstagramOwnerLoginInput) => Promise<{ session: string }>;
  readonly kakaotalk: (
    input: KakaoTalkOwnerLoginInput,
  ) => Promise<{ oauthToken: string; userId: string; deviceUuid: string; deviceType: "pc" | "tablet" }>;
}

export const OwnerLogins: OwnerLogin = {
  slack: (input) => slackOwnerLogin(input),
  discord: (input) => discordOwnerLogin(input),
  instagram: (input) => instagramOwnerLogin(input),
  kakaotalk: (input) => kakaoTalkOwnerLogin(input),
};
