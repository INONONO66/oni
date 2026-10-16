import { afterEach, describe, expect, it } from "bun:test";
import { injectedOptions, testRun } from "./helpers/injected";
import { Operational } from "@openomni/protocol";
import { DiscordClient } from "../src/provider/discord/client";
import { DiscordApiError, DiscordHandlerMissingError } from "../src/errors";
import { DiscordAdapter } from "../src/provider/discord/surface";
import { bounded } from "./helpers/bounded";
import { fakeDiscordSdk } from "./helpers/discord-sdk";

const message = {
  id: "message-1",
  channel_id: "channel-1",
  author: { id: "user-1", username: "user" },
  content: "hello",
};
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Discord audit regressions", () => {
  it("releases a rejected ingress attempt for platform redelivery", async () => {
    const failed = Promise.withResolvers<void>();
    const retried = Promise.withResolvers<void>();
    let handlerAttempts = 0;
    const fake = fakeDiscordSdk();
    const adapter = new DiscordAdapter(
      "token",
      {},
      (event) => {
        if (event.name === Operational.Events.Error.name) failed.resolve();
      },
      injectedOptions(),
      fake.sdk,
    );
    adapter.onMessage(async () => {
      handlerAttempts += 1;
      if (handlerAttempts === 1) throw new Error("delivery refused");
      retried.resolve();
    });
    await adapter.start("boot");
    fake.listener.dispatch("MESSAGE_CREATE", message);
    await bounded(failed.promise);
    fake.listener.dispatch("MESSAGE_CREATE", message);
    await bounded(retried.promise);
    expect(handlerAttempts).toBe(2);
  });

  it("throws a typed error when a Discord API request fails", async () => {
    globalThis.fetch = Object.assign(async () => new Response("forbidden", { status: 403 }), {
      preconnect: realFetch.preconnect,
    });
    const client = new DiscordClient("token", () => undefined, testRun);
    await expect(client.send("channel-1", "hello", "trace-1")).rejects.toBeInstanceOf(
      DiscordApiError,
    );
  });

  it("throws a typed error when start has no message handler", async () => {
    const adapter = new DiscordAdapter(
      "token",
      {},
      () => undefined,
      injectedOptions(),
      fakeDiscordSdk().sdk,
    );
    await expect(adapter.start("trace-1")).rejects.toBeInstanceOf(DiscordHandlerMissingError);
  });
});
