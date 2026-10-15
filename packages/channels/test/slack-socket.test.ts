import { afterEach, describe, expect, it } from "bun:test";
import { Schedule } from "effect";
import { injectedOptions } from "./helpers/injected";
import type { ServerWebSocket } from "bun";
import { Operational } from "@openomni/protocol";
import { z } from "zod";
import { SlackSocket } from "../src/provider/slack/socket";
import type { SocketReconnectShell } from "../src/support/socket-shell";
import type { SocketEnvelope } from "../src/provider/slack/types";
import type { PublishPort } from "../src/types";

/**
 * Socket Mode protocol pins over a real WebSocket against a scripted fake
 * Slack endpoint: hello resolves start, every events_api envelope is acked
 * (before dispatch), disconnect frames trigger a fresh-URL reconnect, and
 * stop() never reconnects. All waits are event-driven signals — no sleeps.
 */

const noopPublish: PublishPort = () => undefined;

class Signal<Value> {
  private readonly resolvers: Array<(value: Value) => void> = [];
  private readonly buffer: Value[] = [];

  emit(value: Value): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver(value);
    } else {
      this.buffer.push(value);
    }
  }

  next(timeoutMs = 5000): Promise<Value> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise<Value>((resolve, reject) => {
      // Resolution is event-driven; this timer only rejects when the signal never fires.
      const timer = setTimeout(() => reject(new Error("timed out waiting for signal")), timeoutMs);
      this.resolvers.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
}

const AckSchema = z.object({ envelope_id: z.string() });

interface FakeSlack {
  readonly url: string;
  readonly opens: Signal<ServerWebSocket<undefined>>;
  readonly acks: Signal<z.infer<typeof AckSchema>>;
  readonly closes: Signal<number>;
  stop(): Promise<void>;
}

function startFakeSlack(): FakeSlack {
  const opens = new Signal<ServerWebSocket<undefined>>();
  const acks = new Signal<z.infer<typeof AckSchema>>();
  const closes = new Signal<number>();
  const server = Bun.serve<undefined>({
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request)) return;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        opens.emit(ws);
      },
      message(_ws, message) {
        acks.emit(AckSchema.parse(JSON.parse(String(message))));
      },
      close(_ws, code) {
        closes.emit(code);
      },
    },
  });
  return {
    url: `ws://localhost:${server.port}`,
    opens,
    acks,
    closes,
    stop: () => server.stop(true),
  };
}

function collectPublishes() {
  const logs: { event: string; error: string | undefined }[] = [];
  const schema = z.object({ context: z.object({ err: z.string().optional() }).optional() });
  const publish: PublishPort = (descriptor, payload) => {
    const log = schema.parse(payload);
    logs.push({ event: descriptor.name, error: log.context?.err });
  };
  return { logs, publish };
}

/** Zero-delay reconnect policy: the schedule seam the shell retries on. */
const immediateSchedule = Schedule.exponential(0);

function messageEnvelope(envelopeId: string, ts: string): SocketEnvelope {
  return {
    type: "events_api",
    envelope_id: envelopeId,
    payload: { event: { type: "message", channel: "C1", ts, text: "hi", user: "U1" } },
  };
}

async function startReady(
  fake: FakeSlack,
  socket: SlackSocket,
): Promise<ServerWebSocket<undefined>> {
  const opened = fake.opens.next().then((ws) => {
    ws.send(JSON.stringify({ type: "hello" }));
    return ws;
  });
  const [ws] = await Promise.all([opened, socket.start()]);
  return ws;
}

describe("SlackSocket", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  function harness(options?: {
    fetchUrl?: (fake: FakeSlack, attempt: number) => Promise<string>;
    publish?: PublishPort;
  }) {
    const fake = startFakeSlack();
    const events = new Signal<SocketEnvelope>();
    let fetches = 0;
    const socket = new SlackSocket(
      () => {
        fetches += 1;
        return options?.fetchUrl?.(fake, fetches) ?? Promise.resolve(fake.url);
      },
      { onEvent: (envelope) => events.emit(envelope) },
      options?.publish ?? noopPublish,
      injectedOptions(),
      immediateSchedule,
    );
    cleanups.push(() => {
      socket.stop();
      return fake.stop();
    });
    return { fake, events, socket, fetchCount: () => fetches };
  }

  it("acks an interactive block action before invoking the event callback", async () => {
    const fake = startFakeSlack();
    const calls: string[] = [];
    const dispatched = Promise.withResolvers<void>();
    const socket = new SlackSocket(
      () => Promise.resolve(fake.url),
      { onEvent: () => { calls.push("dispatch"); dispatched.resolve(); } },
      noopPublish, injectedOptions(),
    );
    const shell = Reflect.get(socket, "shell") as SocketReconnectShell;
    const open = shell.openWebSocket.bind(shell);
    shell.openWebSocket = (url, wire) => open(url, (ws, settle) => {
      const send = ws.send.bind(ws);
      Reflect.set(ws, "send", (value: string) => {
        calls.push("ack");
        return send(value);
      });
      wire(ws, settle);
    });
    cleanups.push(() => { socket.stop(); return fake.stop(); });
    const ws = await startReady(fake, socket);
    ws.send(JSON.stringify({
      type: "interactive", envelope_id: "env-button",
      payload: { type: "block_actions", actions: [{ action_id: "approve" }] },
    }));
    await dispatched.promise;
    expect(await fake.acks.next()).toEqual({ envelope_id: "env-button" });
    expect(calls).toEqual(["ack", "dispatch"]);
  });

  it("acks interactive envelopes despite malformed payload fields", async () => {
    const { fake, events, socket } = harness();
    const ws = await startReady(fake, socket);
    const acknowledged = fake.acks.next();
    const dispatched = events.next();
    ws.send(JSON.stringify({
      type: "interactive", envelope_id: "env-malformed",
      payload: { type: "block_actions", user: "unexpected", channel: [], actions: {} },
    }));

    expect(await acknowledged).toEqual({ envelope_id: "env-malformed" });
    expect((await dispatched).payload).toMatchObject({
      type: "block_actions", user: undefined, channel: undefined, actions: undefined,
    });
  });

  it("resolves start on hello, acks every events_api envelope, then dispatches it", async () => {
    const { fake, events, socket } = harness();
    const started = socket.start();
    const ws = await fake.opens.next();
    ws.send(JSON.stringify({ type: "hello" }));
    await started;

    const envelope = messageEnvelope("env-1", "1.0");
    ws.send(JSON.stringify(envelope));

    expect(await fake.acks.next()).toEqual({ envelope_id: "env-1" });
    expect(await events.next()).toEqual(envelope);
  });

  it("disconnect frame closes the socket and a new connection comes up", async () => {
    const { fake, events, socket, fetchCount } = harness();
    const ws1 = await startReady(fake, socket);
    ws1.send(JSON.stringify({ type: "disconnect", envelope_id: "env-d", reason: "refresh" }));
    expect(await fake.acks.next()).toEqual({ envelope_id: "env-d" });
    expect(await fake.closes.next()).toBe(4000);

    const ws2 = await fake.opens.next();
    ws2.send(JSON.stringify({ type: "hello" }));
    ws2.send(JSON.stringify(messageEnvelope("env-2", "2.0")));
    expect((await events.next()).envelope_id).toBe("env-2");
    expect(fetchCount()).toBe(2);
  });

  it("retries the socket-url fetch during reconnect until it succeeds", async () => {
    const { logs, publish } = collectPublishes();
    const { fake, events, socket } = harness({
      publish,
      fetchUrl: (fakeSlack, attempt) =>
        attempt === 2
          ? Promise.reject(new Error("slack api down"))
          : Promise.resolve(fakeSlack.url),
    });
    const ws1 = await startReady(fake, socket);
    ws1.send(JSON.stringify({ type: "disconnect", reason: "refresh" }));
    const ws2 = await fake.opens.next();
    ws2.send(JSON.stringify({ type: "hello" }));
    ws2.send(JSON.stringify(messageEnvelope("env-3", "3.0")));
    expect((await events.next()).envelope_id).toBe("env-3");
    expect(logs.filter((log) => log.event === Operational.Events.Error.name)).toEqual([
      { event: Operational.Events.Error.name, error: String(new Error("slack api down")) },
    ]);
  });

  it("drops a malformed frame with a warning and keeps the connection serving", async () => {
    const { logs, publish } = collectPublishes();
    const { fake, events, socket } = harness({ publish });
    const started = socket.start();
    const ws = await fake.opens.next();
    ws.send(JSON.stringify({ type: "hello" }));
    await started;

    ws.send("this is not json");
    ws.send(JSON.stringify(messageEnvelope("env-4", "4.0")));
    expect((await events.next()).envelope_id).toBe("env-4");
    expect(logs.filter((log) => log.event === Operational.Events.Warn.name)).toHaveLength(1);
  });

  it("publishes a dispatch error when the event callback throws", async () => {
    const { logs, publish } = collectPublishes();
    const fake = startFakeSlack();
    const socket = new SlackSocket(
      () => Promise.resolve(fake.url),
      {
        onEvent: () => {
          throw new Error("handler exploded");
        },
      },
      publish,
      injectedOptions(),
      immediateSchedule,
    );
    cleanups.push(() => {
      socket.stop();
      return fake.stop();
    });

    const started = socket.start();
    const ws = await fake.opens.next();
    ws.send(JSON.stringify({ type: "hello" }));
    await started;

    ws.send(JSON.stringify(messageEnvelope("env-5", "5.0")));
    expect(await fake.acks.next()).toEqual({ envelope_id: "env-5" });
    // The ack arrived over the wire AFTER dispatch ran locally, so the error is recorded by now.
    expect(logs).toContainEqual({
      event: Operational.Events.Error.name,
      error: "handler exploded",
    });
  });

  it("stop() closes cleanly and never reconnects", async () => {
    const fake = startFakeSlack();
    let fetches = 0;
    const socket = new SlackSocket(
      () => {
        fetches += 1;
        return Promise.resolve(fake.url);
      },
      { onEvent: () => undefined },
      noopPublish,
      injectedOptions(),
      immediateSchedule,
    );
    cleanups.push(() => fake.stop());

    const started = socket.start();
    (await fake.opens.next()).send(JSON.stringify({ type: "hello" }));
    await started;

    socket.stop();
    expect(await fake.closes.next()).toBe(1000);
    // The close handler runs before this microtask flush; a reconnect (even
    // under the zero-delay schedule) would have fetched a fresh URL first.
    await Promise.resolve();
    expect(fetches).toBe(1);
  });

  it("rejects start when the server closes before hello, without reconnecting", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, srv) {
        if (srv.upgrade(request)) return;
        return new Response("expected websocket", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.close(1011, "boot rejected");
        },
        message() {
          // no acks expected
        },
      },
    });
    let fetches = 0;
    const socket = new SlackSocket(
      () => {
        fetches += 1;
        return Promise.resolve(`ws://localhost:${server.port}`);
      },
      { onEvent: () => undefined },
      noopPublish,
      injectedOptions(),
      immediateSchedule,
    );
    cleanups.push(() => {
      socket.stop();
      return server.stop(true);
    });

    await expect(socket.start()).rejects.toThrow("slack socket closed before hello");
    expect(fetches).toBe(1);
  });
});
