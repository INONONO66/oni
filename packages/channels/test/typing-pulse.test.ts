import { afterEach, expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { DiscordProvider } from "../src/provider/discord/provider";
import { TelegramProvider } from "../src/provider/telegram/provider";
import type { ProviderTypingRoute } from "../src/provider/contract";
import { typingPulse } from "../src/support/typing-pulse";
import { testClockRuntime } from "./helpers/effect";
import { injectedOptions } from "./helpers/injected";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.each([
  {
    provider: "telegram",
    route: () => TelegramProvider.create({ token: "tg-test" }, {}, () => undefined, injectedOptions()).typingRoute,
    url: "https://api.telegram.org/bottg-test/sendChatAction",
  },
  {
    provider: "discord",
    route: () => DiscordProvider.create({ token: "dc-test" }, {}, () => undefined, injectedOptions()).typingRoute,
    url: "https://discord.com/api/v10/channels/C1/typing",
  },
])("$provider repeats typing while the turn is open and stops at scope close", async ({ route, url }) => {
  const clock = testClockRuntime();
  const calls: Request[] = [];
  const first = Promise.withResolvers<void>();
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(String(input), init));
    first.resolve();
    return url.includes("telegram")
      ? Response.json({ ok: true, result: true })
      : new Response(null, { status: 204 });
  }, { preconnect: originalFetch.preconnect });
  const stop = await clock.run(Deferred.make<void>());
  const pulse = route();
  if (pulse === undefined) throw new Error("provider has no typing route");
  const running = clock.run(Effect.scoped(Effect.gen(function* () {
    yield* typingPulse(pulse, "U1", { channelId: "C1" }).pipe(Effect.forkScoped);
    yield* Deferred.await(stop);
  })));
  try {
    await first.promise;
    expect(calls).toHaveLength(1);
    await clock.adjust(3_999);
    expect(calls).toHaveLength(1);
    await clock.adjust(1);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => [call.url, call.method])).toEqual([[url, "POST"], [url, "POST"]]);
    await clock.run(Deferred.succeed(stop, undefined));
    await running;
    await clock.adjust(12_000);
    expect(calls).toHaveLength(2);
  } finally {
    await clock.run(Deferred.succeed(stop, undefined));
    await running;
    await clock.dispose();
  }
});

test("a rejected typing call does not end the pulse or fail its turn", async () => {
  const clock = testClockRuntime();
  const first = Promise.withResolvers<void>();
  let calls = 0;
  const route: ProviderTypingRoute = async () => {
    calls += 1;
    first.resolve();
    if (calls === 1) throw new Error("typing rejected");
  };
  const stop = await clock.run(Deferred.make<void>());
  const running = clock.run(Effect.scoped(Effect.gen(function* () {
    yield* typingPulse(route, "U1").pipe(Effect.forkScoped);
    yield* Deferred.await(stop);
  })));
  try {
    await first.promise;
    await clock.adjust(4_000);
    expect(calls).toBe(2);
    await clock.run(Deferred.succeed(stop, undefined));
    await running;
    await clock.adjust(12_000);
    expect(calls).toBe(2);
  } finally {
    await clock.run(Deferred.succeed(stop, undefined));
    await running;
    await clock.dispose();
  }
});
