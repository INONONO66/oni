import { expect, test } from "bun:test";
import type { ServerWebSocket, WebSocketOptions } from "bun";
import { Operational } from "@openomni/protocol";
import { Schedule } from "effect";
import { z } from "zod";
import { SlackSocket } from "../src/provider/slack/socket";
import { DiscordGateway } from "../src/provider/discord/gateway";
import { TelegramPoller } from "../src/provider/telegram/poller";
import { TelegramUpdateSchema } from "../src/provider/telegram/types";
import { bounded } from "./helpers/bounded";
import { injectedOptions } from "./helpers/injected";

function websocketServer(
  onOpen: (peer: ServerWebSocket<undefined>, server: Bun.Server<undefined>) => void,
) {
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, instance) {
      if (instance.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(peer) {
        onOpen(peer, server);
      },
      message: () => undefined,
    },
  });
  return server;
}

function telegramUpdates(server: Bun.Server<undefined>) {
  return {
    async getUpdates() {
      return z.array(TelegramUpdateSchema).parse(await (await fetch(server.url)).json());
    },
    async answerCallbackQuery() { return; },
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

for (const provider of ["slack", "discord"] as const) {
  test(`${provider}: callbacks on a retired real socket cannot dispatch or schedule reconnect`, async () => {
    const NativeWebSocket = globalThis.WebSocket;
    const clients: WebSocket[] = [];
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, options?: WebSocketOptions);
      constructor(url: string | URL, protocols?: string | string[]);
      constructor(url: string | URL, protocols?: string | string[] | WebSocketOptions) {
        if (typeof protocols === "object" && !Array.isArray(protocols)) super(url, protocols);
        else super(url, protocols);
        clients.push(this);
      }
    };
    const peers: ServerWebSocket<undefined>[] = [];
    const received = Promise.withResolvers<void>();
    const events: string[] = [];
    const logs: string[] = [];
    const server = websocketServer((ws, server) => {
      peers.push(ws);
      ws.send(
        JSON.stringify(
          provider === "slack"
            ? { type: "hello" }
            : {
                op: 0,
                t: "READY",
                s: 1,
                d: {
                  session_id: "session",
                  resume_gateway_url: `ws://127.0.0.1:${server.port}`,
                  user: { id: "bot", username: "bot" },
                },
              },
        ),
      );
    });
    const url = `ws://127.0.0.1:${server.port}`;
    const publish = (event: { name: string }) => {
      logs.push(event.name);
    };
    const socket =
      provider === "slack"
        ? new SlackSocket(
            async () => url,
            {
              onEvent(envelope) {
                events.push(envelope.envelope_id ?? "missing");
                received.resolve();
              },
            },
            publish,
            injectedOptions(),
          )
        : new DiscordGateway(
            "token",
            async () => url,
            {
              onReady: () => undefined,
              onDispatch(event) {
                events.push(event);
                received.resolve();
              },
            },
            publish,
            injectedOptions(),
          );
    const frame = (id: string) =>
      provider === "slack"
        ? { type: "events_api", envelope_id: id, payload: { event: { type: "message" } } }
        : { op: 0, t: id, s: 2, d: {} };
    try {
      await bounded(socket.start());
      const retired = clients[0];
      if (!retired) throw new Error("missing initial socket");
      await bounded(socket.start());
      const logsBefore = logs.length;
      // Deliver callbacks already queued by the retired transport deterministically.
      retired.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame("stale")) }));
      retired.dispatchEvent(new CloseEvent("close", { code: 4000 }));
      retired.dispatchEvent(new Event("error"));
      expect(events).toEqual([]);
      expect(logs).toHaveLength(logsBefore);
      peers[1]?.send(JSON.stringify(frame("current")));
      await bounded(received.promise);
      expect(events).toEqual(["current"]);
    } finally {
      socket.stop();
      globalThis.WebSocket = NativeWebSocket;
      await server.stop(true);
    }
  });
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
