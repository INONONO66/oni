import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import { Effect, Logger } from "effect";
import { connectIpcClient as connectNative, createIpcServer as listenNative } from "../../src/ipc";

function resilienceIds(prefix: string): () => string {
  let n = 0;
  return () => { n += 1; return `${prefix}-${n}`; };
}
import { acquire } from "./helpers/effects";
import { connectIpcClient } from "./helpers/native";
import { IpcConnectionError, IpcRemoteError } from "../../src/ipc/errors";
import { createIpcServer } from "./helpers/native";
import { captureError, deferred, within } from "./helpers/signal";
import { socketPath as socketPathForTest } from "./helpers/socket-path";
import { transportFixture } from "./helpers/transport";

/** Collects Effect log entries whose message mentions `marker` and reports the level. */
function collectingLogger(marker: string, resolve: (logLevel: string) => void) {
  return Logger.make((options) => {
    const text = (Array.isArray(options.message) ? options.message : [options.message]).map(String).join(" ");
    if (text.includes(marker)) resolve(options.logLevel);
  });
}

describe("IPC transport resilience (#QB1)", () => {
  const { servers, clients } = transportFixture();

  test("throwing onRequest handler → typed error frame, not a process crash", async () => {
    const socketPath = socketPathForTest("throw");
    const srv = await createIpcServer(socketPath, () => undefined);
    servers.push(srv);

    const client = await connectIpcClient(socketPath, {
      onRequest(method, _params, respond) {
        if (method === "boom") throw new TypeError("handler blew up");
        respond({ ok: method });
      },
    });
    clients.push(client);

    await expect(srv.call("boom", { x: 1 })).rejects.toThrow("handler blew up");

    // Process + socket survived: a normal request still round-trips.
    expect(await srv.call("ok")).toEqual({ ok: "ok" });
  });

  test("removing the active connection lets the next connection bind", async () => {
    const socketPath = socketPathForTest("active");
    const disconnected = deferred<string>();
    const connectionIds = new Map<string, string>();
    const srv = await createIpcServer(
      socketPath,
      (method, params, respond, _notify, connectionId) => {
        if (method === "register") connectionIds.set(String(params?.name), connectionId);
        respond({ ok: true });
      },
      { onDisconnect: disconnected.resolve },
    );
    servers.push(srv);

    const c1 = await connectIpcClient(socketPath, {
      onRequest: (_m, _p, respond) => respond({ from: "c1" }),
    });
    clients.push(c1);
    await c1.call("register", { name: "c1" });
    const c1ConnectionId = connectionIds.get("c1");
    if (!c1ConnectionId) throw new Error("c1 connection id was not captured");
    expect(srv.native.isConnected(c1ConnectionId)).toBe(true);
    srv.useConnection(c1ConnectionId);

    const c2 = await connectIpcClient(socketPath, {
      onRequest: (_m, _p, respond) => respond({ from: "c2" }),
    });
    clients.push(c2);
    await c2.call("register", { name: "c2" });

    // The selected active connection routes calls to c1.
    expect(await srv.call("ping")).toEqual({ from: "c1" });

    // Drop the active connection.
    c1.close();
    expect(await within(disconnected.promise, "active connection removal")).toBe(c1ConnectionId);
    expect(srv.native.isConnected(c1ConnectionId)).toBe(false);

    // Clearing the active id lets the surviving connection bind.
    expect(await srv.call("ping")).toEqual({ from: "c2" });
  });

  test("ASYNC-rejecting server handler → typed error frame, not a burned timeout", async () => {
    const socketPath = socketPathForTest("async-throw-server");
    const srv = await createIpcServer(socketPath, async (method, _params, respond) => {
      if (method === "boom") throw new TypeError("async handler blew up");
      respond({ ok: method });
    });
    servers.push(srv);
    const client = await connectIpcClient(socketPath);
    clients.push(client);

    const error = await captureError(client.call("boom", {}, 2_000));
    expect(error).toBeInstanceOf(IpcRemoteError);
    expect(error.message).toContain("async handler blew up");

    // Process + socket survived: a normal request still round-trips.
    expect(await client.call("ok", {}, 2_000)).toEqual({ ok: "ok" });
  });

  test("ASYNC-rejecting client onRequest → typed error frame, not a burned timeout", async () => {
    const socketPath = socketPathForTest("async-throw-client");
    const srv = await createIpcServer(socketPath, () => undefined);
    servers.push(srv);
    const client = await connectIpcClient(socketPath, {
      onRequest: async (method, _params, respond) => {
        if (method === "boom") throw new TypeError("async client handler blew up");
        respond({ ok: method });
      },
    });
    clients.push(client);

    const error = await captureError(srv.call("boom", {}, 2_000));
    expect(error).toBeInstanceOf(IpcRemoteError);
    expect(error.message).toContain("async client handler blew up");
    expect(await srv.call("ok", {}, 2_000)).toEqual({ ok: "ok" });
  });

  test("a schema-mismatch frame is logged by the client through the Effect logger, not silently dropped", async () => {
    const socketPath = socketPathForTest("schema-warn");
    // Raw peer that emits valid JSON matching no message schema.
    const rawServer = net.createServer((conn) => {
      conn.write('{"v":2,"type":"mystery"}\n');
    });
    await new Promise<void>((resolve) => rawServer.listen(socketPath, () => resolve()));

    const logged = deferred<string>();
    const collector = collectingLogger("matched no message schema", logged.resolve);
    const { value: client, close } = await acquire(connectNative(socketPath, { idSource: resilienceIds("warn-client"), dispatcherBound: 8 }).pipe(Effect.provide(Logger.layer([collector]))));
    try {
      // The captured log entry carries the Warn level, not a console spy.
      expect(await within(logged.promise, "schema mismatch warning")).toBe("Warn");
      // A drifted peer is surfaced, not fatal: the connection stays usable.
      expect(client.connected).toBe(true);
    } finally {
      await close();
      rawServer.close();
    }
  });

  test("a request handler defect is logged through the Effect logger and the connection is removed", async () => {
    const socketPath = socketPathForTest("defect-log");
    const logged = deferred<string>();
    const collector = collectingLogger("request handler defect", logged.resolve);
    const disconnected = deferred<string>();
    const { close } = await acquire(listenNative(socketPath, () => Effect.die(new Error("deliberate handler defect")), {
      idSource: resilienceIds("defect-server"), dispatcherBound: 8,
      onDisconnect: (id) => Effect.sync(() => disconnected.resolve(id)),
    }).pipe(Effect.provide(Logger.layer([collector]))));
    try {
      const client = await connectIpcClient(socketPath);
      clients.push(client);

      // The defect kills the connection: the in-flight call fails as a connection loss.
      const error = await captureError(client.call("boom", {}, 2_000));
      expect(error).toBeInstanceOf(IpcConnectionError);
      // The captured log entry carries the Error level, not a console spy.
      expect(await within(logged.promise, "handler defect error log")).toBe("Error");
      await within(disconnected.promise, "defect connection removal");
    } finally {
      await close();
    }
  });

  test("createIpcServer refuses to steal a LIVE server's socket", async () => {
    const socketPath = socketPathForTest("live-probe");
    const incumbent = await createIpcServer(socketPath, (_method, _params, respond) =>
      respond({ owner: "incumbent" }),
    );
    servers.push(incumbent);

    await expect(createIpcServer(socketPath, () => undefined)).rejects.toBeInstanceOf(
      IpcConnectionError,
    );

    // The incumbent is untouched.
    const client = await connectIpcClient(socketPath);
    clients.push(client);
    expect(await client.call("ping", {}, 2_000)).toEqual({ owner: "incumbent" });
  });

  test("a provably dead socket path is reclaimed", async () => {
    const socketPath = socketPathForTest("stale-file");
    fs.writeFileSync(socketPath, ""); // stale leftover: connecting to it fails
    const srv = await createIpcServer(socketPath, (_method, _params, respond) =>
      respond({ ok: true }),
    );
    servers.push(srv);

    const client = await connectIpcClient(socketPath);
    clients.push(client);
    expect(await client.call("ping", {}, 2_000)).toEqual({ ok: true });
  });

  test("notify() reports a drop (false) vs a delivery (true)", async () => {
    const socketPath = socketPathForTest("notify-signal");
    const srv = await createIpcServer(socketPath, () => undefined);
    servers.push(srv);

    // No connection: the notification is dropped and the caller can tell.
    expect(srv.notify("event.fired", {})).toBe(false);

    const delivered = deferred();
    const client = await connectIpcClient(socketPath, {
      onNotification: (method) => {
        if (method === "event.fired") delivered.resolve();
      },
    });
    clients.push(client);
    expect(srv.notify("event.fired", {})).toBe(true);
    await within(delivered.promise, "notification delivery");
  });
});
