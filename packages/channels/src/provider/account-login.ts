import { type DiscordAccountLoginInput, discordAccountLogin } from "./discord/account-sdk.js";
import { type InstagramAccountLoginInput, instagramAccountLogin } from "./instagram/account-sdk.js";
import { type KakaoTalkAccountLoginInput, kakaoTalkAccountLogin } from "./kakaotalk/account-sdk.js";
import { type SlackAccountLoginInput, slackAccountLogin } from "./slack/account-sdk.js";
import { type TelegramAccountLogin, telegramAccountLogin } from "./telegram/account-sdk.js";

/** Implemented by the login lane without changing the existing login value here. */
export type AccountLoginWithTelegram = AccountLogin & {
  readonly telegram: TelegramAccountLogin;
};

/**
 * The Account's own sign-in on each platform (#1569 lane 5b): each flow rides
 * the agent-messenger SDK through the platform's one seam and returns the
 * credential payload the platform's Account arm admits — never touching the
 * SDK's own credential store. The composing CLI seals the payload through
 * the daemon's `channel_add`.
 */
export interface AccountLogin {
  readonly slack: (input: SlackAccountLoginInput) => Promise<{ token: string; cookie: string; workspace: string }>;
  readonly discord: (input: DiscordAccountLoginInput) => Promise<{ token: string; userId?: string; username?: string }>;
  readonly instagram: (input: InstagramAccountLoginInput) => Promise<{ session: string }>;
  readonly kakaotalk: (
    input: KakaoTalkAccountLoginInput,
  ) => Promise<{ oauthToken: string; userId: string; deviceUuid: string; deviceType: "pc" | "tablet" }>;
}

export const AccountLogins: AccountLoginWithTelegram = {
  slack: (input) => slackAccountLogin(input),
  discord: (input) => discordAccountLogin(input),
  instagram: (input) => instagramAccountLogin(input),
  kakaotalk: (input) => kakaoTalkAccountLogin(input),
  telegram: (input) => telegramAccountLogin(input),
};
