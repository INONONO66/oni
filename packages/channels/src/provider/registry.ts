import { createA2AProvider } from "./a2a/provider.js";
import { DiscordProvider } from "./discord/provider.js";
import { GitHubProvider } from "./github/provider.js";
import { InstagramProvider } from "./instagram/provider.js";
import { KakaoTalkProvider } from "./kakaotalk/provider.js";
import { LinearProvider } from "./linear/provider.js";
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
  /** #1569 lane 7: Owner-only platforms — no bot account; reached through the `owner` arm alone. */
  instagram: typeof InstagramProvider;
  kakaotalk: typeof KakaoTalkProvider;
  /** #1569 lane 9b: Linear, hand-rolled — signed webhook ingress, comments out through the GraphQL API. */
  linear: typeof LinearProvider;
  /** #1569 lane 9c: the A2A door; the shipped entry admits no peer — composition binds the declared roster. */
  a2a: ReturnType<typeof createA2AProvider>;
}> = {
  telegram: TelegramProvider,
  discord: DiscordProvider,
  github: GitHubProvider,
  slack: SlackProvider,
  webhook: WebhookProvider,
  instagram: InstagramProvider,
  kakaotalk: KakaoTalkProvider,
  linear: LinearProvider,
  a2a: createA2AProvider(async () => [], { name: "Oni Resident", description: "unbound", version: "0" }),
} as const;
