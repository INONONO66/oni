import { DiscordAdapter } from "../../src/provider/discord/surface";
import { injectedOptions } from "./injected";
import { TelegramAdapter } from "../../src/provider/telegram/surface";
import { ChannelProviders } from "../../src/provider/registry";
import type { PublishPort } from "../../src/types";
import { fakeDiscordSdk } from "./discord-sdk";
import { fakeTelegramSdk } from "./telegram-sdk";
import { setSdkResponse } from "./sdk-script";

/** The providers use scripted SDK clients; Slack's boundary is the same seam (#1569). */
type Provider = "discord" | "telegram";

export function deliveryFixture(provider: Provider, publish: PublishPort = () => undefined) {
  if (provider === "discord") {
    const fake = fakeDiscordSdk();
    const adapter = new DiscordAdapter("token", {}, publish, injectedOptions(), fake.sdk);
    const limit = ChannelProviders[provider].capabilities.render.messageLimit;
    if (limit === null) throw new Error("delivery fixture requires a bounded provider");
    return { adapter, limit, address: "123", client: fake.client };
  }
  const fake = fakeTelegramSdk();
  const adapter = new TelegramAdapter("token", {}, publish, injectedOptions(), fake.sdk);
  const limit = ChannelProviders[provider].capabilities.render.messageLimit;
  if (limit === null) throw new Error("delivery fixture requires a bounded provider");
  return { adapter, limit, address: "123", client: fake.client };
}

export function installDeliveryFetch(send: () => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  setSdkResponse(send);
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm" });
      if (!["/channels/dm/messages", "/sendMessage"].some((path) => url.endsWith(path)))
        throw new Error(`unexpected delivery request: ${url}`);
      return await send();
    },
    { preconnect: original.preconnect },
  );
  return () => {
    globalThis.fetch = original;
    setSdkResponse(undefined);
  };
}
