import { expect, test } from "bun:test";
import { Outbound } from "@openomni/protocol";
import { DiscordBotError } from "agent-messenger/discordbot";
import { TelegramBotError } from "agent-messenger/telegrambot";
import { deliveryFixture } from "./helpers/delivery";

test.each(["discord", "telegram"] as const)("a 429 is rejected and never resent for %s", async (provider) => {
  const fixture = deliveryFixture(provider);
  if (provider === "discord")
    fixture.client.fail("createMessage", new DiscordBotError("rate limited", "rate_limited", { httpStatus: 429 }));
  else
    fixture.client.fail("sendMessage", new TelegramBotError("rate limited", "rate_limited", { httpStatus: 429 }));
  const first = await fixture.adapter.deliver(fixture.address, Outbound.payload("hello"), "429-key");
  expect(first).toEqual({ value: "not_sent" });
  expect(fixture.client.calls.filter(({ method }) => method === (provider === "discord" ? "createMessage" : "sendMessage"))).toHaveLength(1);
});
