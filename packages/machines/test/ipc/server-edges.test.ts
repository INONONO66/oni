import { describe, expect, test } from "bun:test";
import { mkdirSync, rmdirSync, statSync } from "node:fs";
import net from "node:net";
import { Ipc } from "@oni/protocol";
import { connectIpcClient } from "./helpers/native";
import { IpcConnectionError, IpcTimeoutError } from "../../src/ipc/errors";
import { MachinesFailure } from "../../src/errors";
import { LineDecoder } from "../../src/ipc/framing";
import { createIpcServer } from "./helpers/native";
import { captureError, deferred, within } from "./helpers/signal";
import { socketPath as socketPathForTest } from "./helpers/socket-path";
import { connectRaw, transportFixture } from "./helpers/transport";

async function exchange(socketPath: string, line: string): Promise<Ipc.Response> {
  const socket = new net.Socket();
  const decoder = new LineDecoder();
  return new Promise((resolve, reject) => {
    // Bounded failure guard: resolution is event-driven (first decoded frame); the timer only
    // rejects the test instead of hanging when the frame never arrives.
    const timeout = setTimeout(() => reject(new Error("IPC response timeout")), 1_000);
    socket.on("data", (chunk) => {
      const frame = decoder.push(chunk).frames[0];
      const parsed = Ipc.Response.safeParse(frame);
      if (parsed.success) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(parsed.data);
      }
    });
    socket.once("error", reject);
    socket.connect(socketPath, () => socket.write(line));
  });
}

describe("server edge branches", () => {
  const { servers, rawSockets } = transportFixture();

  for (const method of ["request.one", "request.two"] as const) {
    test(`${method} without a connected client rejects with IpcConnectionError`, async () => {
      const srv = await createIpcServer(socketPathForTest(`noclient-${method}`), () => undefined);
      servers.push(srv);
      await expect(srv.call(method, {})).rejects.toThrow(IpcConnectionError);
    });
  }

  test("refuses to unlink a non-socket path", async () => {
    const path = socketPathForTest("directory");
    mkdirSync(path);
    try {
      const error = await captureError(createIpcServer(path, () => undefined));
      expect(error).toBeInstanceOf(MachinesFailure);
      if (!(error instanceof MachinesFailure)) throw error;
      expect(error.operation).toBe("socket.unlink");
      expect(error.cause).toContain("EISDIR");
      expect(statSync(path).isDirectory()).toBe(true);
    } finally {
      rmdirSync(path);
    }
  });

  test("calls in either direction that never get a response reject with IpcTimeoutError", async () => {
    const srv = await createIpcServer(socketPathForTest("timeout"), () => undefined);
    servers.push(srv);
    rawSockets.push(await connectRaw(srv.socketPath));
    await expect(srv.call("request.timeout", {}, 30)).rejects.toThrow(IpcTimeoutError);

    const client = await connectIpcClient(srv.socketPath);
    await expect(client.call("request.attach", {}, 30)).rejects.toBeInstanceOf(IpcTimeoutError);
    client.close();
  });

  test("schema-invalid frames get bounded, correlated 4000 responses", async () => {
    const srv = await createIpcServer(socketPathForTest("protocol"), () => undefined);
    servers.push(srv);
    const unknown = await exchange(srv.socketPath, '{"neither":"request-nor-response"}\n');
    expect(unknown.type).toBe("response");
    expect(unknown.id).toBe("unknown");
    expect(unknown.error?.code).toBe(4000);

    const correlated = await exchange(
      srv.socketPath,
      '{"v":2,"type":"request","id":"req-correlate-1"}\n',
    );
    expect(correlated.id).toBe("req-correlate-1");
    expect(correlated.error?.code).toBe(4000);

    const oversharing = JSON.stringify({ neither: "z".repeat(5_000) });
    const bounded = await exchange(srv.socketPath, `${oversharing}\n`);
    expect(bounded.error?.code).toBe(4000);
    expect(bounded.error?.message.length).toBeLessThanOrEqual(250);
  });

  test("notification handler failures are contained (sync throw and async rejection)", async () => {
    const seen: string[] = [];
    const bothHandled = deferred();
    const srv = await createIpcServer(socketPathForTest("notify"), (method) => {
      seen.push(method);
      if (seen.length === 2) bothHandled.resolve();
      if (method === "sync.boom") throw new Error("sync failure");
      return Promise.reject(new Error("async failure"));
    });
    servers.push(srv);
    const socket = await connectRaw(srv.socketPath);
    rawSockets.push(socket);

    // Notifications get no error responses per the protocol spec — the
    // server must survive both failure shapes and keep serving.
    socket.write(`${JSON.stringify(Ipc.createNotification("sync.boom", {}))}\n`);
    socket.write(`${JSON.stringify(Ipc.createNotification("async.boom", {}))}\n`);
    await within(bothHandled.promise, "both failing notification handlers");

    expect(seen).toEqual(["sync.boom", "async.boom"]);
    expect(socket.destroyed).toBe(false);
  });

  test("a data-callback error removes the connection and reports its exact id", async () => {
    const disconnected = deferred<string>();
    const callbackError = new Error("request callback failed");
    Object.defineProperty(callbackError, "message", {
      get() {
        throw new Error("callback exploded");
      },
    });
    const srv = await createIpcServer(
      socketPathForTest("callback-error"),
      () => {
        throw callbackError;
      },
      { onDisconnect: (id) => disconnected.resolve(id) },
    );
    servers.push(srv);
    const socket = await connectRaw(srv.socketPath);
    rawSockets.push(socket);

    socket.write(`${JSON.stringify(Ipc.createRequest("callback-error", "explode", {}))}\n`);
    await expect(
      within(disconnected.promise, "disconnect after data callback error"),
    ).resolves.toBe("conn-1");
    await expect(srv.call("request.callback", {})).rejects.toThrow("no connected client");
  });

  test("a client that errors mid-connection is removed and the server keeps serving", async () => {
    const disconnected = deferred();
    const srv = await createIpcServer(
      socketPathForTest("sockerr"),
      (_m, _p, respond) => {
        respond({ ok: true });
      },
      { onDisconnect: () => disconnected.resolve() },
    );
    servers.push(srv);

    const first = await connectRaw(srv.socketPath);
    rawSockets.push(first);
    first.on("error", () => {
      // Client-local: destroy(err) emits here; the server observes the close.
    });
    first.destroy(new Error("simulated transport failure"));
    await within(disconnected.promise, "server removal of errored client");

    // Client→server direction is deterministic (no active-connection routing):
    // the fresh client sends a request and must get the handler's response,
    // proving the abrupt first-client death left the server serving.
    const second = await connectRaw(srv.socketPath);
    rawSockets.push(second);
    const reply = new Promise<string>((resolve) => {
      second.once("data", (chunk) => resolve(String(chunk)));
    });
    second.write(
      `${JSON.stringify(Ipc.createRequest("request-handler", "request.handler", {}))}\n`,
    );
    const frame = Ipc.Response.parse(JSON.parse(await reply));
    expect(frame.type).toBe("response");
    expect(frame.result).toEqual({ ok: true });
  });
});
