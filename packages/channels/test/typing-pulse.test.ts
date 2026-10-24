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
import { TelegramBotError } from "../src/provider/telegram/sdk";
import { DeliveryNotSent } from "../src/errors";

async function pulseUntil(clock: ReturnType<typeof testClockRuntime>, route: ProviderTypingRoute, externalId: string, conversation?: { channelId: string; threadId?: string }) {
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
  const { stop, running } = await pulseUntil(clock, route, "123", { channelId: "456", threadId: "77" });
  try {
    await clock.adjust(0);
    const pulses = () => fake.client.calls.filter(({ method }) => method === "sendChatAction");
    expect(pulses()).toEqual([{ method: "sendChatAction", chatId: "456", options: { action: "typing", message_thread_id: 77 } }]);
    await clock.adjust(3_999);
    expect(pulses()).toHaveLength(1);
    await clock.adjust(1);
    expect(pulses()).toHaveLength(2);
    expect(pulses()[1]).toEqual(pulses()[0]);
  } finally {
    await clock.run(Deferred.succeed(stop, undefined));
    await running;
    await clock.adjust(40_000);
    expect(fake.client.calls.filter(({ method }) => method === "sendChatAction")).toHaveLength(2);
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
    expect(fake.client.calls).toMatchObject([
      { method: "createDm", channelId: "123" },
      { method: "triggerTyping", channelId: "D-owner" },
    ]);
    await clock.adjust(7_999);
    expect(fake.client.calls).toHaveLength(2);
    await clock.adjust(1);
    expect(fake.client.calls.map(({ method }) => method)).toEqual(["createDm", "triggerTyping", "triggerTyping"]);
    expect(fake.client.calls[2]).toMatchObject({ channelId: "D-owner" });
  } finally {
    await clock.run(Deferred.succeed(stop, undefined));
    await running;
    await clock.adjust(80_000);
    expect(fake.client.calls.map(({ method }) => method)).toEqual(["createDm", "triggerTyping", "triggerTyping"]);
    await clock.dispose();
  }
});

test("a refused typing pulse skips one beat and recovers on the next cadence", async () => {
  const fake = fakeTelegramSdk();
  fake.client.fail("sendChatAction", new TelegramBotError("refused", "forbidden", { httpStatus: 403 }));
  const route = createTelegramProvider(fake.sdk).create({ token: "token" }, {}, () => undefined, injectedOptions()).typingRoute;
  if (!route) throw new Error("telegram has no typing route");
  const clock = testClockRuntime();
  const { stop, running } = await pulseUntil(clock, route, "123");
  try {
    await clock.adjust(0);
    expect(fake.client.calls).toHaveLength(0);
    await clock.adjust(4_000);
    expect(fake.client.calls.map(({ method }) => method)).toEqual(["sendChatAction"]);
  } finally {
    await clock.run(Deferred.succeed(stop, undefined));
    await running;
    await clock.adjust(40_000);
    expect(fake.client.calls).toHaveLength(1);
    await clock.dispose();
  }
});

test("a refused typing open never pulses or reopens during the turn", async () => {
  let opens = 0;
  let pulses = 0;
  const route: ProviderTypingRoute = {
    everyMs: 4_000,
    open: () => {
      opens++;
      return Promise.reject(new DeliveryNotSent({ operation: "open", cause: "refused" }));
    },
    pulse: () => { pulses++; return Promise.resolve(); },
  };
  const clock = testClockRuntime();
  const { stop, running } = await pulseUntil(clock, route, "123");
  try {
    await clock.adjust(40_000);
    expect({ opens, pulses }).toEqual({ opens: 1, pulses: 0 });
  } finally {
    await clock.run(Deferred.succeed(stop, undefined));
    await running;
    await clock.adjust(40_000);
    expect({ opens, pulses }).toEqual({ opens: 1, pulses: 0 });
    await clock.dispose();
  }
});
