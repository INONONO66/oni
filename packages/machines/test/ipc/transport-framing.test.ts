import { describe, expect, test } from "bun:test";
import net from "node:net";
import { Ipc } from "@oni/protocol";
import { IpcConnectionError } from "../../src/ipc/errors";
import { connectIpcClient, createIpcServer } from "./helpers/native";
import { captureError, deferred, within } from "./helpers/signal";
import { socketPath } from "./helpers/socket-path";
import { connectRaw, transportFixture } from "./helpers/transport";

describe("transport framing lifecycle", () => {
  const { servers, clients, rawSockets } = transportFixture();

  test("closing a client rejects its pending and subsequent calls", async () => {
    const requested = deferred();
    const server = await createIpcServer(socketPath("closed-call"), () => requested.resolve());
    servers.push(server);
    const client = await connectIpcClient(server.socketPath);
    clients.push(client);
    const pending = client.call("unanswered");
    const rejected = captureError(pending);
    await within(requested.promise, "server receiving pending call");
    client.close();
    expect(await within(rejected, "pending call closed")).toMatchObject({ message: "client closed" });
    expect(client.connected).toBe(false);
    await expect(client.call("after.close")).rejects.toThrow("not connected");
  });

  test("FIN discards an incomplete response and rejects an upload with queued bytes", async () => {
    const path = socketPath("fin-backlog");
    const prefixReceived = deferred<number>();
    const disconnected = deferred();
    const rawServer = net.createServer({ allowHalfOpen: true }, (socket) => {
      rawSockets.push(socket);
      socket.once("data", (chunk) => {
        socket.pause();
        prefixReceived.resolve(chunk.length);
        // Deliberately stop reading the request before its send backlog can drain.
        socket.end('{"v":2,"type":"response","id":"unfinished"');
      });
    });
    const listening = new Promise<void>((resolve, reject) => {
      rawServer.once("error", reject);
      rawServer.listen(path, resolve);
    });
    await within(listening, "raw FIN server listening");
    try {
      const client = await connectIpcClient(path, { onDisconnect: disconnected.resolve });
      clients.push(client);
      const payload = "x".repeat(8 * 1024 * 1024);
      const call = client.call("upload", { payload }, 30_000);
      const rejected = captureError(call);
      expect(await within(prefixReceived.promise, "request prefix")).toBeLessThan(payload.length);
      expect(await within(rejected, "FIN rejection with queued bytes")).toBeInstanceOf(IpcConnectionError);
      await within(disconnected.promise, "client close after FIN");
      expect(client.connected).toBe(false);
    } finally {
      rawServer.close();
    }
  });

  test("disconnect mid-frame never dispatches a partial request or contaminates a new peer", async () => {
    const processed = deferred();
    const disconnected = deferred<string>();
    const methods: string[] = [];
    const server = await createIpcServer(
      socketPath("partial-close"),
      (method, _params, respond) => {
        methods.push(method);
        if (method === "prefix.barrier") processed.resolve();
        respond({ method });
      },
      { onDisconnect: disconnected.resolve },
    );
    servers.push(server);
    const raw = await connectRaw(server.socketPath);
    rawSockets.push(raw);
    raw.write(`${JSON.stringify(Ipc.createNotification("prefix.barrier"))}\n{"v":2,"type":"request","id":"partial"`);
    await within(processed.promise, "complete frame before partial request");
    raw.destroy();
    await within(disconnected.promise, "mid-frame disconnect");
    const replacement = await connectIpcClient(server.socketPath);
    clients.push(replacement);
    expect(await replacement.call("after.reconnect")).toEqual({ method: "after.reconnect" });
    expect(methods).toEqual(["prefix.barrier", "after.reconnect"]);
  });
});
