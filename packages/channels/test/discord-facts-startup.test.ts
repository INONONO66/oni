import { expect, test } from "bun:test";
import { injectedOptions } from "./helpers/injected";
import type { ServerWebSocket } from "bun";
import { Operational, type Channel } from "@openomni/protocol";
import { z } from "zod";
import { DiscordAdapter } from "../src/provider/discord/surface";
import { bounded } from "./helpers/bounded";

test("Discord READY binds the facts-only handler on a real gateway connection", async () => {
  const connected = Promise.withResolvers<ServerWebSocket<undefined>>();
  const incoming = Promise.withResolvers<Channel.InboundMessage>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, self) {
      return self.upgrade(request) ? undefined : new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open(socket: ServerWebSocket<undefined>) {
        connected.resolve(socket);
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
      },
      message(socket, data) {
        const frame = z.object({ op: z.number() }).parse(JSON.parse(String(data)));
        if (frame.op === 2)
          socket.send(
            JSON.stringify({
              op: 0,
              t: "READY",
              s: 1,
              d: {
                session_id: "session",
                resume_gateway_url: `ws://127.0.0.1:${server.port}`,
                user: { id: "bot", username: "openomni" },
              },
            }),
          );
        if (frame.op === 1) socket.send(JSON.stringify({ op: 11, d: null }));
      },
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => Response.json({ url: `ws://127.0.0.1:${server.port}` }),
    { preconnect: realFetch.preconnect },
  );
  const adapter = new DiscordAdapter("token", {}, () => undefined, injectedOptions());
  adapter.onMessage(async (message) => {
    incoming.resolve(message);
  });
  try {
    await bounded(adapter.start("boot"));
    const socket = await bounded(connected.promise);
    socket.send(
      JSON.stringify({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 2,
        d: {
          id: "message",
          channel_id: "dm",
          author: { id: "user", username: "Sender" },
          content: "hello",
        },
      }),
    );
    expect(await bounded(incoming.promise)).toMatchObject({
      sender: { kind: "external", externalId: "user" },
      facts: { eventId: "message", render: "hello" },
    });
  } finally {
    adapter.stop("stop");
    await server.stop(true);
    globalThis.fetch = realFetch;
  }
});

test("Discord component interactions acknowledge through the API before handoff and warn-drop on refusal", async () => {
  const connected = Promise.withResolvers<ServerWebSocket<undefined>>();
  const received = Promise.withResolvers<Channel.InboundMessage>();
  const warned = Promise.withResolvers<string>();
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, self) {
      return self.upgrade(request) ? undefined : new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open(socket: ServerWebSocket<undefined>) {
        connected.resolve(socket);
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      },
      message(socket, data) {
        const frame = z.object({ op: z.number() }).parse(JSON.parse(String(data)));
        if (frame.op === 2) socket.send(JSON.stringify({
          op: 0, t: "READY", s: 1, d: {
            session_id: "session", resume_gateway_url: `ws://127.0.0.1:${server.port}`,
            user: { id: "bot", username: "openomni" },
          },
        }));
        if (frame.op === 1) socket.send(JSON.stringify({ op: 11, d: null }));
      },
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/gateway/bot")) return Response.json({ url: `ws://127.0.0.1:${server.port}` });
    const body = z.object({ type: z.literal(6) }).parse(JSON.parse(String(init?.body)));
    expect(body.type).toBe(6);
    calls.push(`ack:${path.includes("/refused/") ? "refused" : "accepted"}`);
    return new Response(null, { status: path.includes("/refused/") ? 403 : 204 });
  }, { preconnect: realFetch.preconnect });
  const adapter = new DiscordAdapter("token", {}, (event, data) => {
    if (event.name === Operational.Events.Warn.name) {
      const warning = z.object({
        msg: z.string(), context: z.object({ err: z.string() }).optional(),
      }).parse(data);
      if (warning.msg === "discord interaction acknowledgment failed; dropped")
        warned.resolve(warning.context?.err ?? "");
    }
  }, injectedOptions());
  adapter.onMessage(async (message) => { calls.push("handoff"); received.resolve(message); });
  try {
    await bounded(adapter.start("boot"));
    const socket = await bounded(connected.promise);
    const interaction = (id: string) => ({
      op: 0, t: "INTERACTION_CREATE", s: 2,
      d: {
        type: 3, id, token: "token", channel_id: "dm", user: { id: "user", username: "Sender" },
        data: { custom_id: "approve" },
        message: { id: "sent", components: [{ components: [{ custom_id: "approve", label: "Approve" }] }] },
      },
    });
    socket.send(JSON.stringify(interaction("accepted")));
    expect(await bounded(received.promise)).toMatchObject({
      facts: { event: "postback", render: "Approve", postback: {
        id: "approve", label: "Approve", messageRef: "sent",
      } },
    });
    socket.send(JSON.stringify(interaction("refused")));
    expect(await bounded(warned.promise)).not.toContain("/refused/token/");
    expect(calls).toEqual(["ack:accepted", "handoff", "ack:refused"]);
  } finally {
    adapter.stop("stop");
    await server.stop(true);
    globalThis.fetch = realFetch;
  }
});
