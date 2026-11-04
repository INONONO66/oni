import { afterEach, describe, expect, test } from "bun:test";
import https from "node:https";
import { Ipc } from "@oni/protocol";
import { z } from "zod";
import { MAX_FRAME_BYTES } from "../../src/ipc/framing";
import { IPC_WS_PATH } from "../../src/ipc/ws-server";
import { connectIpcWsClient, createIpcWsServer } from "./helpers/native";
import { deferred, within } from "./helpers/signal";
import { daemonIdentity, hostIdentity } from "./helpers/tls-fixtures";

const LOOPBACK = "127.0.0.1";
const BIG_PAYLOAD = "x".repeat(8 * 1024 * 1024);
const LargeResult = z.object({ data: z.string() });

describe("ws listener edges (#1830)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  async function listening(handler: Parameters<typeof createIpcWsServer>[1] = (_m, _p, respond) => respond({ ok: true })) {
    const server = await createIpcWsServer({ host: LOOPBACK, port: 0, tls: hostIdentity }, handler);
    cleanups.push(() => { void server.close(); });
    return server;
  }
  function status(port: number, path: string) {
    return new Promise<number>((resolve, reject) => {
      const request = https.request({ host: LOOPBACK, port, path, ca: [hostIdentity.certificate], checkServerIdentity: () => undefined }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.once("error", reject);
      request.end();
    });
  }
  function rawWs(port: number) {
    const closed = deferred<{ code: number; reason: string }>();
    const opened = deferred();
    const socket = new WebSocket(`wss://${LOOPBACK}:${port}${IPC_WS_PATH}`, { tls: { rejectUnauthorized: false } });
    socket.onopen = () => opened.resolve();
    socket.onclose = (event) => closed.resolve({ code: event.code, reason: event.reason });
    cleanups.push(() => socket.close());
    return { socket, opened: opened.promise, closed: closed.promise };
  }

  test("a request for another path is refused with 404 and a plain request for /machine with 426", async () => {
    const server = await listening();
    expect(await status(server.port, "/ws")).toBe(404);
    expect(await status(server.port, IPC_WS_PATH)).toBe(426);
  });

  test("a text message closes the connection with 1003 before the core sees it", async () => {
    const seen: string[] = [];
    const server = await listening((method, _p, respond) => { seen.push(method); respond({}); });
    const raw = rawWs(server.port);
    await within(raw.opened, "ws open");
    raw.socket.send(`${JSON.stringify(Ipc.createRequest("text-1", "text.frame", {}))}\n`);
    expect(await within(raw.closed, "ws close")).toEqual({ code: 1003, reason: "the machine wire carries binary frames only" });
    expect(seen).toEqual([]);
  });

  test("a frame split across messages past the decoder cap is refused with 4001 and the server closes", async () => {
    const server = await listening();
    const raw = rawWs(server.port);
    const refused = deferred<Ipc.Response>();
    raw.socket.binaryType = "arraybuffer";
    raw.socket.onmessage = (event) => refused.resolve(Ipc.Response.parse(JSON.parse(Buffer.from(event.data as ArrayBuffer).toString())));
    await within(raw.opened, "ws open");
    const half = Buffer.alloc(MAX_FRAME_BYTES / 2 + 1, 0x78);
    raw.socket.send(half);
    raw.socket.send(half);
    expect(await within(refused.promise, "4001 refusal", 10_000)).toMatchObject({ id: "unknown", error: { code: 4001, message: `IPC frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes` } });
    expect((await within(raw.closed, "server close")).code).toBe(1000);
  }, 15_000);

  test("a multi-megabyte response crosses the ws backpressure path byte-exact", async () => {
    const server = await listening((_m, _p, respond) => respond({ data: BIG_PAYLOAD }));
    const client = await connectIpcWsClient({ ws: { host: LOOPBACK, port: server.port }, tls: daemonIdentity, hostCertificate: hostIdentity.certificate });
    cleanups.push(() => { void client.close(); });
    const result = LargeResult.parse(await client.call("get-big", {}, 10_000));
    expect(result.data.length).toBe(BIG_PAYLOAD.length);
    expect(result.data === BIG_PAYLOAD).toBe(true);
  }, 15_000);
});
