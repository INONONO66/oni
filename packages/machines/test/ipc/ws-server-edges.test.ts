import { afterEach, describe, expect, test } from "bun:test";
import { Ipc } from "@oni/protocol";
import { z } from "zod";
import { MAX_FRAME_BYTES } from "../../src/ipc/framing";
import { OPCODE_BINARY } from "../../src/ipc/ws-frames";
import { IPC_WS_PATH } from "../../src/ipc/ws-server";
import { connectIpcWsClient, createIpcWsServer } from "./helpers/native";
import { OPCODE_TEXT, rawWs } from "./helpers/raw-ws";
import { within } from "./helpers/signal";
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
  function pinnedRawWs(port: number, path?: string, upgrade?: boolean) {
    const raw = rawWs({ host: LOOPBACK, port, tls: daemonIdentity, hostCertificate: hostIdentity.certificate }, path, upgrade);
    cleanups.push(() => raw.destroy());
    return raw;
  }

  test("a connection presenting no client certificate is ended during the TLS handshake, before any upgrade", async () => {
    const seen: string[] = [];
    const server = await listening((method, _p, respond) => { seen.push(method); respond({}); });
    const raw = rawWs({ host: LOOPBACK, port: server.port, hostCertificate: hostIdentity.certificate });
    cleanups.push(() => raw.destroy());
    expect(await within(raw.ended, "socket end")).toEqual({ received: 0 });
    expect(server.notify("probe", {})).toBe(false);
    expect(seen).toEqual([]);
  });

  test("a request for another path is refused with 404 and a plain request for /machine with 426", async () => {
    const server = await listening();
    expect(await within(pinnedRawWs(server.port, "/ws").opened, "404 status")).toBe("HTTP/1.1 404 Not Found");
    expect(await within(pinnedRawWs(server.port, IPC_WS_PATH, false).opened, "426 status")).toBe("HTTP/1.1 426 Upgrade Required");
  });

  test("a text message closes the connection with 1003 before the core sees it", async () => {
    const seen: string[] = [];
    const server = await listening((method, _p, respond) => { seen.push(method); respond({}); });
    const raw = pinnedRawWs(server.port);
    expect(await within(raw.opened, "ws open")).toBe("HTTP/1.1 101 Switching Protocols");
    raw.send(OPCODE_TEXT, `${JSON.stringify(Ipc.createRequest("text-1", "text.frame", {}))}\n`);
    expect(await within(raw.closed, "ws close")).toEqual({ code: 1003, reason: "the machine wire carries binary frames only" });
    expect(await within(raw.ended, "socket end")).toMatchObject({});
    expect(seen).toEqual([]);
  });

  test("a frame split across messages past the decoder cap is refused with 4001 and the server closes", async () => {
    const server = await listening();
    const raw = pinnedRawWs(server.port);
    await within(raw.opened, "ws open");
    const half = Buffer.alloc(MAX_FRAME_BYTES / 2 + 1, 0x78);
    raw.send(OPCODE_BINARY, half);
    raw.send(OPCODE_BINARY, half);
    const refused = raw.nextMessage().then((bytes) => Ipc.Response.parse(JSON.parse(bytes.toString())));
    expect(await within(refused, "4001 refusal", 10_000)).toMatchObject({ id: "unknown", error: { code: 4001, message: `IPC frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes` } });
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
