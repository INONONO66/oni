import { expect, spyOn, test } from "bun:test";
import net from "node:net";
import { Ipc } from "@oni/protocol";
import { Effect } from "effect";
import { connectIpcClient } from "../../src/ipc/client";
import { IpcConnectionError, IpcProtocolError } from "../../src/ipc/errors";
import { encode, LineDecoder } from "../../src/ipc/framing";
import { createIpcServer } from "../../src/ipc/server";
import { acquire, run } from "./helpers/effects";
import { captureError, deferred, within } from "./helpers/signal";
import { sequentialIds } from "./helpers/native";
import { socketPath } from "./helpers/socket-path";

async function rawServer() {
  const accepted = deferred<net.Socket>();
  const path = socketPath("native");
  const server = net.createServer((socket) => accepted.resolve(socket));
  await within(new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  }), "server listen");
  return {
    path,
    accepted: accepted.promise,
    close: () => within(new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }), "server close"),
  };
}

for (const failure of ["malformed", "disconnect"] as const) {
  test(`native socket ${failure} fails the pending RPC without replay`, async () => {
    const server = await rawServer();
    const client = await acquire(connectIpcClient(server.path, { idSource: sequentialIds("native-client"), dispatcherBound: 8 }));
    const socket = await within(server.accepted, "server accept");
    const closed = deferred();
    socket.once("close", () => closed.resolve());
    const received = deferred();
    const decoder = new LineDecoder();
    const requests: Ipc.Request[] = [];
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk).frames) requests.push(Ipc.Request.parse(frame));
      if (requests.length > 0) received.resolve();
    });
    try {
      const failed = captureError(run(client.value.call("pending")));
      await within(received.promise, "request received before failure");
      if (failure === "malformed") socket.write("not-json\n");
      else socket.end();
      const error = await within(failed, "pending RPC failure");
      expect(error).toBeInstanceOf(failure === "malformed" ? IpcProtocolError : IpcConnectionError);
      expect(error).toMatchObject({ _tag: failure === "malformed" ? "IpcProtocolError" : "IpcConnectionError" });
      await within(closed.promise, "peer socket close");
      expect(client.value.connected).toBe(false);
      expect(await captureError(run(client.value.call("after-close")))).toBeInstanceOf(IpcConnectionError);
      expect(requests.map((request) => request.method)).toEqual(["pending"]);
    } finally {
      await client.close();
      socket.destroy();
      await server.close();
    }
  });
}

test("native scopes release the connection and permit immediate socket-path reuse", async () => {
  const disconnected = deferred();
  const path = socketPath("release");
  const server = await acquire(createIpcServer(path, (_method, _params, respond) => Effect.sync(() => respond({ ok: true })), {
    idSource: sequentialIds("native-server"), dispatcherBound: 8,
    onDisconnect: () => Effect.sync(() => disconnected.resolve()),
  }));
  const client = await acquire(connectIpcClient(path, { idSource: sequentialIds("native-reuse"), dispatcherBound: 8 }));
  try {
    expect(await run(client.value.call("ready"))).toEqual({ ok: true });
    await client.close();
    await within(disconnected.promise, "server observes client socket close");
    expect(client.value.connected).toBe(false);
  } finally {
    await client.close();
    await server.close();
  }
  // Raw bind must succeed without the production server's stale-path unlink/probe.
  const rebound = net.createServer();
  try {
    await within(new Promise<void>((resolve, reject) => {
      rebound.once("error", reject);
      rebound.listen(path, resolve);
    }), "immediate raw rebind");
  } finally {
    await within(new Promise<void>((resolve, reject) => rebound.close((error) => error ? reject(error) : resolve())), "rebound close");
  }
});

test("a retained response callback cannot write to a socket after scope close", async () => {
  const server = await rawServer();
  const entered = deferred<(result: Ipc.Response["result"]) => void>();
  const connecting = net.Socket.prototype.connect;
  let clientSocket: net.Socket | undefined;
  const observation = spyOn(net.Socket.prototype, "connect").mockImplementation(new Proxy(connecting, {
    apply(target: typeof connecting, receiver: net.Socket, args: Parameters<typeof connecting>) {
      clientSocket = receiver;
      return target.apply(receiver, args);
    },
  }));
  const client = await acquire(connectIpcClient(server.path, {
    idSource: sequentialIds("native-callback"), dispatcherBound: 8,
    onRequest: (_method, _params, respond) => Effect.sync(() => entered.resolve(respond)),
  })).finally(() => observation.mockRestore());
  const peer = await within(server.accepted, "callback peer accept");
  try {
    if (!clientSocket) throw new Error("client socket not observed");
    const closed = deferred();
    clientSocket.once("close", () => closed.resolve());
    peer.write(encode(Ipc.createRequest("late", "hold", {})));
    const respond = await within(entered.promise, "request callback captured");
    await client.close();
    await within(closed.promise, "client close event");
    const writes = spyOn(clientSocket, "write");
    try {
      respond({ late: true });
      expect(writes).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
    }
  } finally {
    await client.close();
    peer.destroy();
    await server.close();
  }
});
