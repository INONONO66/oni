import { afterEach, describe, expect, it } from "bun:test";
import { injectedOptions } from "./helpers/injected";
import { type Channel, Operational, type PlainObject, PlainValueSchema } from "@openomni/protocol";
import { z } from "zod";
import { SlackAdapter } from "../src/provider/slack/surface";
import { SlackEndpointKeyError, SlackHandlerMissingError } from "../src/errors";
import type { PublishPort } from "../src/types";
import { bounded } from "./helpers/bounded";

const noopPublish: PublishPort = () => undefined;
const realFetch = globalThis.fetch;
const Body = z.record(z.string(), PlainValueSchema);
type Socket = import("bun").ServerWebSocket<Record<string, never>>;
interface ApiCall {
  readonly method: string;
  readonly body: PlainObject;
}

function installSlackApi() {
  const calls: ApiCall[] = [];
  const posted = Promise.withResolvers<PlainObject>();
  const opened = Promise.withResolvers<Socket>();
  const server = Bun.serve<Record<string, never>>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request, { data: {} })) return;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open: (socket) => opened.resolve(socket),
      message() {
        return;
      },
    },
  });
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const method = String(input).slice(String(input).lastIndexOf("/") + 1);
      const body = Body.parse(JSON.parse(String(init?.body)));
      calls.push({ method, body });
      if (method === "apps.connections.open")
        return Response.json({ ok: true, url: `ws://127.0.0.1:${server.port}` });
      if (method === "auth.test")
        return Response.json({ ok: true, user_id: "UBOT", team_id: "T9" });
      if (method === "conversations.open")
        return Response.json({ ok: true, channel: { id: "D-open" } });
      posted.resolve(body);
      return Response.json({ ok: true, ts: "999.1" });
    },
    { preconnect: realFetch.preconnect },
  );
  return { calls, posts: posted.promise, sockets: opened.promise, stop: () => server.stop(true) };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("SlackAdapter", () => {
  it("refuses to start without a handler", async () => {
    const adapter = new SlackAdapter({ botToken: "xoxb-1", appToken: "xapp-1" }, {}, noopPublish, injectedOptions());
    await expect(adapter.start("trace-1")).rejects.toBeInstanceOf(SlackHandlerMissingError);
  });

  it("delivers a channel event as ingress facts", async () => {
    const api = installSlackApi();
    const adapter = new SlackAdapter({ botToken: "xoxb-1", appToken: "xapp-1" }, {}, noopPublish, injectedOptions());
    const facts = Promise.withResolvers<Channel.InboundMessage>();
    adapter.onMessage(async (message) => {
      facts.resolve(message);
    });
    try {
      const started = adapter.start("trace-1");
      const socket = await bounded(api.sockets);
      socket.send(JSON.stringify({ type: "hello" }));
      await bounded(started);
      socket.send(
        JSON.stringify({
          type: "events_api",
          envelope_id: "env-1",
          payload: {
            event: {
              type: "message",
              channel: "C123",
              channel_type: "channel",
              user: "U77",
              text: "<@UBOT> tracking number",
              ts: "1710.0002",
              thread_ts: "1710.0001",
            },
          },
        }),
      );
      expect(await bounded(facts.promise)).toMatchObject({
        sender: { externalId: "T9:U77" },
        facts: { workspaceId: "T9", channelId: "C123", reply: { chain: ["1710.0001"] } },
      });
    } finally {
      adapter.stop("trace-stop");
      await api.stop();
    }
  });

  it("releases failed ingress for platform redelivery", async () => {
    const api = installSlackApi();
    const failed = Promise.withResolvers<void>();
    const retried = Promise.withResolvers<void>();
    let attempts = 0;
    const adapter = new SlackAdapter(
      { botToken: "xoxb", appToken: "xapp" },
      {},
      (event) => {
        if (event.name === Operational.Events.Error.name) failed.resolve();
      },
      injectedOptions(),
    );
    adapter.onMessage(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("delivery refused");
      retried.resolve();
    });
    try {
      const started = adapter.start("boot");
      const socket = await bounded(api.sockets);
      socket.send(JSON.stringify({ type: "hello" }));
      await bounded(started);
      const frame = JSON.stringify({
        type: "events_api",
        envelope_id: "retry",
        payload: {
          event: {
            type: "message",
            channel: "C123",
            channel_type: "channel",
            user: "U77",
            text: "hello",
            ts: "1.2",
          },
        },
      });
      socket.send(frame);
      await bounded(failed.promise);
      socket.send(frame);
      await bounded(retried.promise);
      expect(attempts).toBe(2);
    } finally {
      adapter.stop("stop");
      await api.stop();
    }
  });

  it("reports a delivery receipt and rejects an unscoped endpoint", async () => {
    const api = installSlackApi();
    try {
      const adapter = new SlackAdapter({ botToken: "xoxb-1", appToken: "xapp-1" }, {}, noopPublish, injectedOptions());
      const receipt = adapter.deliver("T9:U5", "direct note", "message-1");
      expect(await bounded(api.posts)).toEqual({ channel: "D-open", text: "direct note" });
      expect(api.calls.find((call) => call.method === "conversations.open")?.body).toEqual({
        users: "U5",
      });
      expect(await receipt).toEqual({ value: "sent", externalMessageId: "999.1" });
      await expect(adapter.deliver("U5", "no workspace", "message-2")).rejects.toBeInstanceOf(
        SlackEndpointKeyError,
      );
    } finally {
      await api.stop();
    }
  });

  it("posts into the conversation's thread instead of opening a DM (#1490)", async () => {
    const api = installSlackApi();
    try {
      const adapter = new SlackAdapter({ botToken: "xoxb-1", appToken: "xapp-1" }, {}, noopPublish, injectedOptions());
      const receipt = adapter.deliver("T9:U5", "in thread", "message-3", {
        channelId: "C123",
        replyToMessageId: "1710.0002",
      });
      expect(await bounded(api.posts)).toEqual({ channel: "C123", text: "in thread", thread_ts: "1710.0002" });
      expect(await receipt).toEqual({ value: "sent", externalMessageId: "999.1" });
      expect(api.calls.some((call) => call.method === "conversations.open")).toBe(false);
    } finally {
      await api.stop();
    }
  });
});
