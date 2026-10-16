import { expect, test } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Schedule } from "effect";
import { z } from "zod";
import { TelegramPoller } from "../src/provider/telegram/poller";
import { TelegramUpdateSchema } from "../src/provider/telegram/types";
import { bounded } from "./helpers/bounded";
import { injectedOptions } from "./helpers/injected";

function telegramUpdates(server: Bun.Server<undefined>) {
  return {
    async getUpdates() {
      return z.array(TelegramUpdateSchema).parse(await (await fetch(server.url)).json());
    },
    async answerCallbackQuery() {
      return;
    },
  };
}

function collectTelegramMessages(delivered: number[], onDelivery: () => void = () => undefined) {
  return {
    onMessage(message: { message_id: number } | { id: string }) {
      if ("id" in message) return;
      delivered.push(message.message_id);
      onDelivery();
    },
  };
}

const update = (id: number) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 1,
    chat: { id: 7, type: "private" },
    text: "SENTINEL",
  },
});

test("Telegram ignores a retired HTTP response even when cancellation arrives too late", async () => {
  const requested = Promise.withResolvers<void>();
  const oldResponse = Promise.withResolvers<Response>();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (++requests === 1) {
        requested.resolve();
        return oldResponse.promise;
      }
      return Response.json([update(2)]);
    },
  });
  const delivered: number[] = [];
  const poller = new TelegramPoller(
    // A response already in flight may survive abort; the cycle's own
    // AbortController, not abort alone, owns custody of the checkpoint.
    telegramUpdates(server),
    collectTelegramMessages(delivered),
    () => undefined,
    injectedOptions(),
  );
  try {
    const old = poller.pollOnce("old");
    await bounded(requested.promise);
    poller.stop();
    await bounded(poller.pollOnce("new"));
    oldResponse.resolve(Response.json([update(1)]));
    await bounded(old);
    expect(delivered).toEqual([2]);
    expect(requests).toBe(2);
  } finally {
    oldResponse.resolve(Response.json([]));
    poller.stop();
    await server.stop(true);
  }
});

test("Telegram poll errors warn once per cycle and retry on the injected schedule", async () => {
  const arrived = Promise.withResolvers<void>();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return requests === 1 ? new Response("not-json") : Response.json([update(2)]);
    },
  });
  const delivered: number[] = [];
  const warns: string[] = [];
  const poller = new TelegramPoller(
    telegramUpdates(server),
    collectTelegramMessages(delivered, () => {
      poller.stop();
      arrived.resolve();
    }),
    (event, data) => {
      if (event.name === Operational.Events.Warn.name)
        warns.push(z.object({ msg: z.string() }).parse(data).msg);
    },
    injectedOptions(),
    Schedule.exponential(0),
  );
  try {
    const loop = poller.start();
    await bounded(arrived.promise);
    await bounded(loop);
    expect(delivered).toEqual([2]);
    expect(requests).toBe(2);
    expect(warns).toEqual(["telegram poll error"]);
  } finally {
    poller.stop();
    await server.stop(true);
  }
});
