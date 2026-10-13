import { DiscordProvider } from "./discord/provider.js";
import { GitHubProvider } from "./github/provider.js";
import { SlackProvider } from "./slack/provider.js";
import { TelegramProvider } from "./telegram/provider.js";
import { WebhookProvider } from "./webhook/provider.js";

/**
 * The shipped provider set — pure data, no I/O. Composition roots read this
 * to build channel stages; adding a platform means implementing
 * `ChannelProvider` in its driver folder and adding the entry here.
 *
 * The websocket surface is deliberately NOT a provider: it is the loopback
 * bootstrap/recovery surface with no credential and a server-owned lifecycle,
 * and must stay mountable when every credentialed channel is down.
 */
export const ChannelProviders: Readonly<{
  telegram: typeof TelegramProvider;
  discord: typeof DiscordProvider;
  github: typeof GitHubProvider;
  slack: typeof SlackProvider;
  webhook: typeof WebhookProvider;
}> = {
  telegram: TelegramProvider,
  discord: DiscordProvider,
  github: GitHubProvider,
  slack: SlackProvider,
  webhook: WebhookProvider,
} as const;
