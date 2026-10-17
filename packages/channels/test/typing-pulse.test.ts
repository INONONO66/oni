import { expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { createDiscordProvider } from "../src/provider/discord/provider";
import { createTelegramProvider } from "../src/provider/telegram/provider";
import type { ProviderTypingRoute } from "../src/provider/contract";
import { typingPulse } from "../src/support/typing-pulse";
import { testClockRuntime } from "./helpers/effect";
import { injectedOptions } from "./helpers/injected";
import { fakeDiscordSdk } from "./helpers/discord-sdk";
import { fakeTelegramSdk } from "./helpers/telegram-sdk";

async function pulseUntil(clock: ReturnType<typeof testClockRuntime>, route: ProviderTypingRoute, externalId: string, conversation?: { channelId: string }) {
  const stop = await clock.run(Deferred.make<void>());
  const running = clock.run(Effect.scoped(Effect.gen(function* () {
    yield* typingPulse(route, externalId, conversation).pipe(Effect.forkScoped);
    yield* Deferred.await(stop);
  })));
  return { stop, running };
}

test("Telegram typing pulses use the SDK action and stop with the turn", async () => {
  const fake = fakeTelegramSdk();
  const route = createTelegramProvider(fake.sdk).create({ token: "token" }, {}, () => undefined, injectedOptions()).typingRoute;
  if (route === undefined) throw new Error("telegram has no typing route");
  const clock = testClockRuntime();
  const { stop, running } = await pulseUntil(clock, route, "123", { channelId: "456" });
  try {
    await clock.adjust(0);
    await clock.adjust(4_000);
    expect(fake.client.calls.filter(({ method }) => method === "sendChatAction")).toHaveLength(2);
  } finally {
    await clock.run(Deferred.succeed(stop, undefined));
    await running;
    await clock.dispose();
  }
});

test("Discord typing pulses use the SDK action and open a DM once", async () => {
  const fake = fakeDiscordSdk();
  const route = createDiscordProvider(fake.sdk).create({ token: "token" }, {}, () => undefined, injectedOptions()).typingRoute;
  if (route === undefined) throw new Error("discord has no typing route");
  const clock = testClockRuntime();
  const { stop, running } = await pulseUntil(clock, route, "123");
  try {
    await clock.adjust(0);
    await clock.adjust(8_000);
    expect(fake.client.calls.map(({ method }) => method)).toEqual(["createDm", "triggerTyping", "triggerTyping"]);
  } finally {
    await clock.run(Deferred.succeed(stop, undefined));
    await running;
    await clock.dispose();
  }
});
