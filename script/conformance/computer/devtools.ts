/**
 * A local fake DevTools endpoint for the CDP dialect receipts: a loopback
 * TCP listener that answers `GET /json/version` with a browser WebSocket URL
 * on its own port, completes the WebSocket upgrade for that path, and then
 * echoes every upgraded byte back unchanged. The client tunnels those bytes
 * opaquely, so the echo proves the bounded exchange without a browser.
 */
import { createHash } from "node:crypto";

const BROWSER_PATH = "/devtools/browser/conformance";
const ACCEPT_GUID = "258EAFA5-E914-47A5-95CA-C5AB0DC85B11";
const HEAD_END = "\r\n\r\n";

interface Connection {
  head: string;
  upgraded: boolean;
}

export interface FakeDevtools {
  readonly port: number;
  readonly requests: string[];
  stop(): void;
}

function header(head: string, name: string): string | undefined {
  const prefix = `${name.toLowerCase()}:`;
  const line = head.split("\r\n").find((entry) => entry.toLowerCase().startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

function versionReply(port: number): string {
  const body = JSON.stringify({
    Browser: "Conformance/1.0",
    "Protocol-Version": "1.3",
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}${BROWSER_PATH}`,
  });
  return `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

function upgradeReply(key: string): string {
  const accept = createHash("sha1").update(`${key}${ACCEPT_GUID}`).digest("base64");
  return `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
}

export function startFakeDevtools(): FakeDevtools {
  const requests: string[] = [];
  const listener = Bun.listen<Connection>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { head: "", upgraded: false };
      },
      data(socket, chunk) {
        if (socket.data.upgraded) {
          socket.write(chunk);
          return;
        }
        socket.data.head += chunk.toString("latin1");
        const end = socket.data.head.indexOf(HEAD_END);
        if (end < 0) return;
        const head = socket.data.head.slice(0, end);
        const rest = Buffer.from(socket.data.head.slice(end + HEAD_END.length), "latin1");
        const requestLine = head.split("\r\n")[0] ?? "";
        requests.push(requestLine);
        const key = header(head, "sec-websocket-key");
        if (requestLine.startsWith(`GET ${BROWSER_PATH} `) && key !== undefined) {
          socket.data.upgraded = true;
          socket.write(upgradeReply(key));
          if (rest.length > 0) socket.write(rest);
          return;
        }
        // Every other request is discovery; the receipt asserts the exact
        // request lines, so the fake needs no path dispatch of its own.
        socket.end(versionReply(listener.port));
      },
    },
  });
  return { port: listener.port, requests, stop: () => listener.stop(true) };
}
