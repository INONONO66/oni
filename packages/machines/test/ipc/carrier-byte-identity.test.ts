import { afterEach, describe, expect, test } from "bun:test";
import tls from "node:tls";
import { Ipc } from "@oni/protocol";
import { pinnedTlsDial } from "../../src/ipc/client";
import { IPC_WS_PATH } from "../../src/ipc/ws-server";
import { connectIpcTcpClient, connectIpcWsClient, createIpcTcpServer, createIpcWsServer } from "./helpers/native";
import { deferred, within } from "./helpers/signal";
import { daemonIdentity, hostIdentity } from "./helpers/tls-fixtures";

const LOOPBACK = "127.0.0.1";
const REQUEST = Ipc.createRequest("byte-identity-1", "echo", { carrier: "same" });
const REQUEST_BYTES = Buffer.from(`${JSON.stringify(REQUEST)}\n`);
const RESPONSE_BYTES = Buffer.from(`${JSON.stringify({ v: 2, type: "response", id: REQUEST.id, result: { ok: true } })}\n`);
const serverTls = { cert: hostIdentity.certificate, key: hostIdentity.privateKey };
const clientSpec = (port: number) => ({ host: LOOPBACK, port, tls: daemonIdentity, hostCertificate: hostIdentity.certificate });

describe("carrier byte identity (#1830)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  /** Raw recorders answer the one request with the canned response and hand back the request bytes they saw. */
  function recordingTcp() {
    const seen = deferred<Buffer>();
    const server = tls.createServer(serverTls, (socket) => socket.once("data", (chunk) => { seen.resolve(chunk); socket.write(RESPONSE_BYTES); }));
    const listening = new Promise<number>((resolve) => server.listen(0, LOOPBACK, () => resolve(Number((server.address() as { port: number }).port))));
    cleanups.push(() => server.close());
    return { seen, listening };
  }
  function recordingWs() {
    const seen = deferred<Buffer>();
    const server = Bun.serve({
      hostname: LOOPBACK, port: 0, tls: serverTls,
      fetch: (request, bun) => bun.upgrade(request) ? undefined : new Response("", { status: 426 }),
      websocket: { message(ws, message) { if (typeof message !== "string") { seen.resolve(message); ws.send(RESPONSE_BYTES); } } },
    });
    cleanups.push(() => { void server.stop(true); });
    return { seen, port: server.port ?? 0 };
  }
  const echo = (_method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void) => respond({ echoed: params });

  test("the request bytes a server reads are identical over WS and TLS-TCP", async () => {
    const tcp = recordingTcp();
    const ws = recordingWs();
    const idSource = () => REQUEST.id;
    const tcpClient = await connectIpcTcpClient({ tcp: { host: LOOPBACK, port: await tcp.listening }, tls: daemonIdentity, hostCertificate: hostIdentity.certificate }, { idSource });
    const wsClient = await connectIpcWsClient({ ws: { host: LOOPBACK, port: ws.port }, tls: daemonIdentity, hostCertificate: hostIdentity.certificate }, { idSource });
    cleanups.push(() => { void tcpClient.close(); void wsClient.close(); });

    expect(await tcpClient.call("echo", { carrier: "same" })).toEqual({ ok: true });
    expect(await wsClient.call("echo", { carrier: "same" })).toEqual({ ok: true });
    const overTcp = await within(tcp.seen.promise, "tcp request bytes");
    const overWs = await within(ws.seen.promise, "ws request bytes");
    expect(overWs.equals(overTcp)).toBe(true);
    expect(overTcp.subarray(overTcp.length - 1).toString()).toBe("\n");
    expect(JSON.parse(overWs.toString())).toMatchObject({ id: REQUEST.id, method: "echo", params: { carrier: "same" } });
  });

  test("the response bytes a client reads are identical over WS and TLS-TCP", async () => {
    const tcpServer = await createIpcTcpServer({ host: LOOPBACK, port: 0, tls: hostIdentity }, echo);
    const wsServer = await createIpcWsServer({ host: LOOPBACK, port: 0, tls: hostIdentity }, echo);
    cleanups.push(() => { void tcpServer.close(); void wsServer.close(); });

    const overTcp = deferred<Buffer>();
    const { socket } = pinnedTlsDial(clientSpec(tcpServer.port))();
    socket.once("data", (chunk: Buffer) => overTcp.resolve(chunk));
    socket.once("secureConnect", () => socket.write(REQUEST_BYTES));
    cleanups.push(() => socket.destroy());

    const overWs = deferred<Buffer>();
    const raw = new WebSocket(`wss://${LOOPBACK}:${wsServer.port}${IPC_WS_PATH}`, { tls: { rejectUnauthorized: false } });
    raw.binaryType = "arraybuffer";
    raw.onopen = () => raw.send(REQUEST_BYTES);
    raw.onmessage = (event) => overWs.resolve(Buffer.from(event.data as ArrayBuffer));
    cleanups.push(() => raw.close());

    const tcpBytes = await within(overTcp.promise, "tcp response bytes");
    const wsBytes = await within(overWs.promise, "ws response bytes");
    expect(wsBytes.equals(tcpBytes)).toBe(true);
    expect(JSON.parse(wsBytes.toString())).toMatchObject({ id: REQUEST.id, result: { echoed: { carrier: "same" } } });
  });
});
