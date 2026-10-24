import { DiscordAdapter } from "../../src/provider/discord/surface";
import { injectedOptions } from "./injected";
import { TelegramAdapter } from "../../src/provider/telegram/surface";
import { ChannelProviders } from "../../src/provider/registry";
import type { PublishPort } from "../../src/types";
import { DiscordOwnerAdapter } from "../../src/provider/discord/owner";

type Provider = "discord" | "discord-owner" | "telegram";

export function deliveryFixture(provider: Provider, publish: PublishPort = () => undefined) {
  const adapter = provider === "telegram"
    ? new TelegramAdapter("token", {}, publish, injectedOptions())
    : provider === "discord"
      ? new DiscordAdapter("token", {}, publish, injectedOptions())
      : new DiscordOwnerAdapter({ token: "token" }, { intake: "none", autoReply: false }, publish, injectedOptions());
  const limit = ChannelProviders[provider === "telegram" ? "telegram" : "discord"].capabilities.render.messageLimit;
  if (limit === null) throw new Error("delivery fixture requires a bounded provider");
  return { adapter, limit, address: "123" };
}

export function installDeliveryFetch(send: () => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
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
  };
}
