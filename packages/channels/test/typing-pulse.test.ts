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

function fakeFetch(calls: Request[], respond: (url: string) => Response) {
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(String(input), init);
    calls.push(request);
    return respond(request.url);
  }, { preconnect: originalFetch.preconnect });
}

/** Fork one pulse under the virtual clock until `stop` is completed. */
async function pulseUntil(clock: ReturnType<typeof testClockRuntime>, route: ProviderTypingRoute, externalId: string, conversation?: { channelId: string }) {
  const stop = await clock.run(Deferred.make<void>());
  const running = clock.run(Effect.scoped(Effect.gen(function* () {
    yield* typingPulse(route, externalId, conversation).pipe(Effect.forkScoped);
    yield* Deferred.await(stop);
  })));
  return { stop, running };
}

test.each([
  {
    provider: "telegram",
    route: () => TelegramProvider.create({ token: "tg-test" }, {}, () => undefined, injectedOptions()).typingRoute,
    url: "https://api.telegram.org/bottg-test/sendChatAction",
    everyMs: 4_000,
  },
  {
    provider: "discord",
    route: () => DiscordProvider.create({ token: "dc-test" }, {}, () => undefined, injectedOptions()).typingRoute,
    url: "https://discord.com/api/v10/channels/C1/typing",
    everyMs: 8_000,
  },
])("$provider repeats typing on its own window while the turn is open and stops at scope close", async ({ route, url, everyMs }) => {
  const clock = testClockRuntime();
  const calls: Request[] = [];
  fakeFetch(calls, () => url.includes("telegram") ? Response.json({ ok: true, result: true }) : new Response(null, { status: 204 }));
  const pulse = route();
  if (pulse === undefined) throw new Error("provider has no typing route");
  expect(pulse.everyMs).toBe(everyMs);
  const { stop, running } = await pulseUntil(clock, pulse, "U1", { channelId: "C1" });
  try {
    await clock.adjust(0);
    expect(calls).toHaveLength(1);
    await clock.adjust(everyMs - 1);
    expect(calls).toHaveLength(1);
    await clock.adjust(1);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => [call.url, call.method])).toEqual([[url, "POST"], [url, "POST"]]);
    await clock.run(Deferred.succeed(stop, undefined));
    await running;
    await clock.adjust(everyMs * 3);
    expect(calls).toHaveLength(2);
  } finally {
    await clock.run(Deferred.succeed(stop, undefined));
    await running;
    await clock.dispose();
  }
});

test("a discord DM opens its channel once and pulses that channel", async () => {
  const clock = testClockRuntime();
  const calls: Request[] = [];
  fakeFetch(calls, (url) => url.endsWith("/users/@me/channels") ? Response.json({ id: "D9" }) : new Response(null, { status: 204 }));
  const pulse = DiscordProvider.create({ token: "dc-test" }, {}, () => undefined, injectedOptions()).typingRoute;
  if (pulse === undefined) throw new Error("provider has no typing route");
  const { stop, running } = await pulseUntil(clock, pulse, "U1");
  try {
    await clock.adjust(0);
    await clock.adjust(8_000);
    await clock.adjust(8_000);
    expect(calls.map((call) => call.url)).toEqual([
      "https://discord.com/api/v10/users/@me/channels",
      "https://discord.com/api/v10/channels/D9/typing",
      "https://discord.com/api/v10/channels/D9/typing",
      "https://discord.com/api/v10/channels/D9/typing",
    ]);
  } finally {
    await clock.run(Deferred.succeed(stop, undefined));
    await running;
    await clock.dispose();
  }
});

test("a rejected pulse skips one beat; a refused open ends the pulse", async () => {
  const clock = testClockRuntime();
  let pulses = 0;
  let opens = 0;
  const route: ProviderTypingRoute = {
    everyMs: 4_000,
    open: async (externalId) => {
      opens += 1;
      if (externalId === "closed") throw new Error("no channel");
      return { channelId: externalId };
    },
    pulse: async () => {
      pulses += 1;
      if (pulses === 1) throw new Error("typing rejected");
    },
  };
  const first = await pulseUntil(clock, route, "U1");
  const second = await pulseUntil(clock, route, "closed");
  try {
    await clock.adjust(0);
    await clock.adjust(4_000);
    expect(pulses).toBe(2);
    expect(opens).toBe(2);
    await clock.run(Deferred.succeed(first.stop, undefined));
    await clock.run(Deferred.succeed(second.stop, undefined));
    await first.running;
    await second.running;
    await clock.adjust(12_000);
    expect(pulses).toBe(2);
  } finally {
    await clock.run(Deferred.succeed(first.stop, undefined));
    await clock.run(Deferred.succeed(second.stop, undefined));
    await first.running;
    await second.running;
    await clock.dispose();
  }
});
