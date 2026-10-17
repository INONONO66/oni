import { ChannelProviders } from "@openomni/channels";
import type { Channel, Outbound } from "@openomni/protocol";

type ProviderCredentials =
  | Parameters<typeof ChannelProviders.telegram.create>[0]
  | Parameters<typeof ChannelProviders.discord.create>[0]
  | Parameters<typeof ChannelProviders.slack.create>[0]
  | Parameters<typeof ChannelProviders.github.create>[0]
  | Parameters<typeof ChannelProviders.webhook.create>[0];

class FakeSurface implements Channel.Surface {
  handler: Channel.MessageHandler | null = null;
  started = false;
  stopped = false;

  constructor(
    readonly id: string,
    readonly config: Channel.Config,
    readonly credentials: ProviderCredentials,
  ) {}

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }
  start(_traceId: string): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }
  stop(_traceId: string): void {
    this.stopped = true;
  }
}

/** Keep shipped schemas and capabilities; record only the external provider IO. */
export function fakeProviders() {
  const surfaces: FakeSurface[] = [];
  const delivered: { externalId: string; payload: Outbound.Payload }[] = [];
  const webhookCalls: Request[] = [];
  const delivery = (
    id: string,
    credentials: ProviderCredentials,
    config: Channel.Config,
    messageId: string,
  ) => {
    const surface = new FakeSurface(id, config, credentials);
    surfaces.push(surface);
    return {
      surface,
      deliveryRoute: (externalId: string, payload: Outbound.Payload) => {
        delivered.push({ externalId, payload });
        return Promise.resolve({ value: "accepted" as const, externalMessageId: messageId });
      },
    };
  };
  const providers: typeof ChannelProviders = {
    // #1569 lane 7: Owner-only platforms have no bot arm to fake; the shipped entries serve as they are.
    instagram: ChannelProviders.instagram,
    kakaotalk: ChannelProviders.kakaotalk,
    // #1569 lane 9b: Linear is webhook-fed and reaches no network at construction; the shipped entry serves.
    linear: ChannelProviders.linear,
    // #1569 lane 9c: the A2A door admits the composed roster; the shipped entry admits nobody.
    a2a: ChannelProviders.a2a,
    telegram: {
      ...ChannelProviders.telegram,
      create: (credentials, config) => delivery("telegram", credentials, config, "tg-1"),
    },
    discord: {
      ...ChannelProviders.discord,
      create: (credentials, config) => delivery("discord", credentials, config, "dc-1"),
    },
    slack: {
      ...ChannelProviders.slack,
      create: (credentials, config) => delivery("slack", credentials, config, "sl-1"),
    },
    github: {
      ...ChannelProviders.github,
      create(credentials, config) {
        const surface = new FakeSurface("github", config, credentials);
        surfaces.push(surface);
        return {
          surface,
          webhookHandler: (request) => {
            webhookCalls.push(request);
            return Promise.resolve(new Response("OK", { status: 200 }));
          },
        };
      },
    },
    webhook: {
      ...ChannelProviders.webhook,
      create(credentials, config) {
        const surface = new FakeSurface("webhook", config, credentials);
        surfaces.push(surface);
        return {
          surface,
          webhookHandler: (request) => {
            webhookCalls.push(request);
            return Promise.resolve(new Response("OK", { status: 200 }));
          },
        };
      },
    },
  };
  return { surfaces, providers, delivered, webhookCalls };
}
